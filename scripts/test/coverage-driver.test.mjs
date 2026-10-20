import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { repositoryRoot } from "../artifact-paths.mjs";
const run = promisify(execFile);

test("coverage driver normalizes child output and keeps the timing child uninstrumented", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "bifoil coverage routing "));
  const files = [
    "dist/coverage/javascript/lcov.info",
    "dist/coverage/javascript.raw.lcov",
    "dist/coverage/javascript.lcov",
    "dist/coverage/mapping-warnings.json",
  ];
  const saved = new Map();
  for (const file of files)
    saved.set(
      file,
      await readFile(path.join(repositoryRoot, file)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      }),
    );
  try {
    const hook = path.join(folder, "external-process.mjs"),
      trace = path.join(folder, "trace.json");
    // Replace only the operating-system process boundary. The real driver, path
    // validation, LCOV normalization and report writes execute in the child.
    await writeFile(
      hook,
      `
      import child from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const calls=[];
      child.spawnSync=(_executable,args,options)=>{
        calls.push({args,instrumented:Object.hasOwn(options.env,'NODE_V8_COVERAGE')});
        writeFileSync(process.env.BIFOIL_DRIVER_TRACE,JSON.stringify(calls));
        if(process.env.BIFOIL_DRIVER_MODE==='error') return {error:new Error('Original process-boundary failure')};
        return {status:process.env.BIFOIL_DRIVER_MODE==='exit'?2:0};
      };
      syncBuiltinESMExports();
    `,
    );
    await mkdir(path.join(repositoryRoot, "dist/coverage/javascript"), { recursive: true });
    const fixture = "SF:scripts/coverage-report.mjs\nDA:1,1\nBRDA:undefined,0,0,0\nBRF:1\nBRH:0\nend_of_record\n";
    await writeFile(path.join(repositoryRoot, files[0]), fixture);
    const invoke = (mode) =>
      run(process.execPath, ["--import", pathToFileURL(hook).href, "scripts/test-coverage.mjs"], {
        cwd: repositoryRoot,
        env: { ...process.env, BIFOIL_DRIVER_TRACE: trace, BIFOIL_DRIVER_MODE: mode },
        timeout: 10000,
      });
    assert.match((await invoke("success")).stdout, /Recorded 1 V8 branches without source locations/);
    const calls = JSON.parse(await readFile(trace, "utf8"));
    assert.equal(calls.length, 2);
    assert(calls[0].args.some((arg) => arg.includes("c8")));
    assert(calls[1].args.some((arg) => arg.endsWith("performance.test.ts")));
    assert(
      calls.every((call) => call.instrumented === false),
      "Driver leaked coverage into timing execution",
    );
    const normalized = await readFile(path.join(repositoryRoot, "dist/coverage/javascript.lcov"), "utf8");
    assert.match(normalized, /DA:1,1/);
    assert(!normalized.includes("BRDA:undefined"));
    assert.equal(
      JSON.parse(await readFile(path.join(repositoryRoot, "dist/coverage/mapping-warnings.json"), "utf8"))
        .unmappedBranches.length,
      1,
    );
    await assert.rejects(invoke("error"), /Original process-boundary failure/);
    assert.equal(JSON.parse(await readFile(trace, "utf8")).length, 1, "Timing continued after functional failure");
    await assert.rejects(invoke("exit"), (error) => error.code === 2);
    assert.equal(JSON.parse(await readFile(trace, "utf8")).length, 1);
  } finally {
    // Synthetic report data must never become a real analysis input.
    for (const [file, bytes] of saved) {
      const target = path.join(repositoryRoot, file);
      if (bytes === undefined) await rm(target, { force: true });
      else await writeFile(target, bytes);
    }
    await rm(folder, { recursive: true, force: true });
  }
});
