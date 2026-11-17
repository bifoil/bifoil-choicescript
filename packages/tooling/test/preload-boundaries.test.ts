import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { build } from "esbuild";
import { installToolSources } from "../src/tool-source-preload.js";
const execute = promisify(execFile);

test("headless memo caches preserve exact values while bounding retention and restoring descriptors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil memo contract "));
  const globals: Parameters<typeof installToolSources>[1] = {
    parsedLines: { original: true },
    slurpFile: () => "outside text",
    slurpFileLines: () => ["outside lines"],
    crc32: () => 123,
  };
  const previous = Object.getOwnPropertyDescriptor(globals, "parsedLines");
  const originalRun = vm.runInThisContext;
  const originalExec = RegExp.prototype.exec;
  let dispose: (() => void) | undefined;
  try {
    dispose = installToolSources(root, globals);
    const memo = globals!.parsedLines as Record<PropertyKey, unknown>;
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    memo.cycle = cycle;
    assert.equal(memo.cycle, cycle);
    memo.original = [null, true, 2, "text"];
    assert.deepEqual(memo.original, [null, true, 2, "text"]);
    memo.original = "replacement";
    assert.equal(memo.original, "replacement");
    assert.equal(Object.getOwnPropertyDescriptor(memo, "original")!.value, "replacement");
    assert.equal(Object.getOwnPropertyDescriptor(memo, "missing"), undefined);
    const key = Symbol("unmemoized");
    memo[key] = "not retained";
    assert.equal(memo[key], undefined);
    assert.equal(key in memo, false);
    Reflect.set(memo, "hasOwnProperty", "must not replace the method");
    assert.equal(typeof memo.hasOwnProperty, "function");
    assert.equal(memo.hasOwnProperty("original"), true);
    assert.equal(memo.hasOwnProperty("missing"), false);
    memo.huge = "x".repeat(1024 * 1024);
    assert.equal("huge" in memo, false);
    memo.nestedHuge = { value: "x".repeat(1024 * 1024) };
    assert.equal("nestedHuge" in memo, false);
    for (let i = 0; i < 4200; i++) memo["entry" + i] = i;
    assert.equal("entry0" in memo, false);
    assert.equal(memo.entry4199, 4199);
    assert(Object.keys(memo).length <= 4096);
    delete memo.entry4199;
    delete memo.missing;
    delete memo[key];
    assert.equal(memo.entry4199, undefined);
    globals!.parsedLines = {};
    assert.equal(Object.keys(globals!.parsedLines as object).length, 0);
    assert.equal(vm.runInThisContext("41 + 1"), 42);
    assert.equal(vm.runInThisContext("1", "other.js"), 1);
    vm.runInThisContext("", "headless.js");
    vm.runInThisContext("", { filename: "headless.js" });
    assert.equal(globals!.slurpFile!("outside.txt"), "outside text");
    assert.deepEqual(globals!.slurpFileLines!("outside.txt"), ["outside lines"]);
    assert.equal(globals!.crc32!("ordinary string"), 123);
  } finally {
    dispose?.();
    dispose?.();
    assert.equal(vm.runInThisContext, originalRun);
    assert.equal(RegExp.prototype.exec, originalExec);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globals, "parsedLines"), previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("headless activation refuses missing loaders and restores a host without a CRC hook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil missing loader "));
  try {
    for (const globals of [{}, { slurpFile: () => "fallback", slurpFileLines: () => ["fallback"] }]) {
      const dispose = installToolSources(root, globals);
      try {
        if (!Object.hasOwn(globals, "slurpFile"))
          assert.throws(() => vm.runInThisContext("", "headless.js"), /loaders are unavailable/);
        else assert.equal(vm.runInThisContext("42", "headless.js"), 42);
      } finally {
        dispose();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export spooling preserves ordinary JSON and rejects missing or repeated placeholders without leaking staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil export boundary "));
  const preload = path.resolve(".cache/coverage/tests/export-preload-contract.mjs");
  try {
    await mkdir(path.dirname(preload), { recursive: true });
    await build({
      entryPoints: ["packages/tooling/src/export-source-preload.ts"],
      outfile: preload,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      sourcemap: "inline",
      logLevel: "silent",
    });
    const invoke = async (mode: string, marker = 1, destination = "result.html") => {
      const stage = path.join(root, mode);
      await mkdir(path.join(stage, "web/mygame/scenes"), { recursive: true });
      await writeFile(path.join(stage, ".bifoil-tool-stage.json"), JSON.stringify({ format: marker }));
      const lines = [
        "Original Ω",
        ...Array.from({ length: 80 }, (_, i) => String(i) + "x".repeat(5000)),
        "large".repeat(15000),
      ];
      await writeFile(path.join(stage, "web/mygame/scenes/startup.txt"), lines.join("\n"));
      await writeFile(
        path.join(stage, "compile.js"),
        `
        const fs=require('node:fs'),vm=require('node:vm');
        vm.runInThisContext("global.slurpFile=()=>'';global.slurpFileLines=()=>[];"+
          ${JSON.stringify(mode === "no-encoder" ? "" : "global.toJson=JSON.stringify;")},{filename:'headless.js'});
        const source=global.slurpFile('web/mygame/scenes/startup.txt');
        const rows=source.lines();
        const encoded=global.toJson(${mode === "direct" ? "rows" : "rows.map((row)=>row)"});
        fs.writeFileSync('ordinary.txt',Buffer.from('Unchanged ordinary write'));
        const result=${mode === "lost" ? "'missing'" : mode === "duplicate" ? "encoded+encoded" : mode === "unknown" ? "encoded.replace(/_[0-9]+_END/,'_999_END')" : "'before'+encoded+'after'"};
        fs.writeFileSync(process.argv[2]||'output.html',result);
        if(global.toJson({original:1})!=='{\"original\":1}')throw new Error('ordinary JSON changed');
      `,
      );
      const child = execute(process.execPath, ["--import", pathToFileURL(preload).href, "compile.js", destination], {
        cwd: stage,
        timeout: 15000,
      });
      if (["lost", "duplicate", "unknown", "no-encoder", "bad-marker", "outside"].includes(mode))
        await assert.rejects(child, /placeholder|encoder is unavailable|owned staging directory|owned stage/);
      else {
        await child;
        assert.equal(await readFile(path.join(stage, destination), "utf8"), "before" + JSON.stringify(lines) + "after");
        assert.equal(await readFile(path.join(stage, "ordinary.txt"), "utf8"), "Unchanged ordinary write");
      }
      assert(
        !(await readdir(stage)).some(
          (name) => name.startsWith(".bifoil-export-") || name.startsWith(".bifoil-source-"),
        ),
      );
    };
    for (const mode of ["mapped", "direct", "lost", "duplicate", "unknown", "no-encoder"]) await invoke(mode);
    await invoke("bad-marker", 0);
    await invoke("outside", 1, "../must-not-write.html");
  } finally {
    // The report reader needs the generated text and inline map after the test
    // process exits, matching the other coverage-only test bundles.
    if (!process.env.NODE_V8_COVERAGE) await rm(preload, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
