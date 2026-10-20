import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { build } from "esbuild";
import { ToolRunner } from "../src/runner.js";
import type { Project } from "../../protocol/src/index.js";
import { installToolSources } from "../src/tool-source-preload.js";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);

test("headless adapter preserves official CRC and source validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil preload CRC Ω "));
  let dispose: (() => void) | undefined;
  try {
    const scenes = path.join(root, "web/mygame/scenes");
    await mkdir(scenes, { recursive: true });
    const util = await readFile("vendor/choicescript/web/util.js", "utf8");
    const context = vm.createContext({ console });
    vm.runInContext(util, context);
    const crc = context.crc32 as (text: string, crc?: number) => number;
    const globals = {
      slurpFile: (_name: string): unknown => "fallback",
      slurpFileLines: (_name: string) => ["fallback"],
      crc32: (value: unknown, initial?: number) => crc(String(value), initial),
    };
    dispose = installToolSources(root, globals);
    vm.runInThisContext("", { filename: "headless.js" });
    for (const [index, text] of [
      "",
      "\ufeffUnicode Ω 😀.\r\n\r\r\nLast\r",
      "A " + "😀".repeat(20000) + "\r\nB.",
    ].entries()) {
      const file = path.join(scenes, `source${index}.txt`);
      await writeFile(file, text);
      const lines = text.split(/\r?\n/);
      if (lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
      const reference = lines.join("\n"),
        source = globals.slurpFile(file);
      for (const initial of [undefined, 0, 12345, -7921])
        assert.equal(globals.crc32(source, initial), crc(reference, initial));
      assert.deepEqual([...globals.slurpFileLines(file)], lines);
    }
    assert.equal(globals.slurpFile("outside.txt"), "fallback");
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("official generator QuickTest and seeded RandomTest match with bounded sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil original tools Ω "));
  const scenes = path.join(root, "scenes");
  await mkdir(scenes);
  const startup = `*title Original bounded source test
*author Chinay
*create gender "male"
*create implicit_control_flow true
*create score 1
*scene_list
  startup
  chapter
She said "This is the end,
*if gender = "male"
  William."
*else
  Belle."
*gosub increment
*finish
*label increment
*set score +1
*return
`;
  await writeFile(path.join(scenes, "startup.txt"), startup);
  await writeFile(path.join(scenes, "chapter.txt"), "Original chapter ${score}.\n*ending\n");
  await writeFile(path.join(scenes, "choicescript_stats.txt"), "Original stats.\n");
  const project: Project = {
    id: pathToFileURL(scenes).href,
    root,
    sceneDir: scenes,
    assetDir: root,
    name: "Original bounded source",
  };
  const runner = new ToolRunner(path.resolve("vendor/choicescript"), () => {});
  let stage: string | undefined;
  try {
    stage = await runner.stage(project, []);
    const preload = path.join(root, "tool-source-preload.cjs");
    await build({
      entryPoints: ["packages/tooling/src/tool-source-preload.ts"],
      outfile: preload,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      logLevel: "silent",
    });
    const normalize = (text: string) => text.replace(/^Time: .*s\r?\n/gm, "");
    for (const [script, args] of [
      ["mygamegenerator.js", ["mygame"]],
      ["quicktest.js", ["mygame"]],
      ["randomtest.js", ["num=2", "game=mygame", "seed=12", "showChoices=false", "showCoverage=true", "delay=false"]],
    ] as const) {
      const baseline: { stdout: string; stderr: string } = await execute(
        process.execPath,
        ["--max-old-space-size=64", script, ...args],
        {
          cwd: stage,
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
      );
      const adapted: { stdout: string; stderr: string } = await execute(
        process.execPath,
        ["--max-old-space-size=64", "--require", preload, script, ...args],
        { cwd: stage, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      );
      assert.equal(normalize(adapted.stdout), normalize(baseline.stdout), script + " output differs");
      assert.equal(adapted.stderr, baseline.stderr, script + " errors differ");
    }
  } finally {
    await runner.dispose();
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
