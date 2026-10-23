import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { repositoryRoot } from "../artifact-paths.mjs";
/** @type {typeof import("node:child_process").execFile.__promisify__} */
const run = promisify(execFile);
const invoke = (script, args = [], env = {}) =>
  run(process.execPath, [script, ...args], { cwd: repositoryRoot, env: { ...process.env, ...env }, timeout: 10000 });

test("coverage command failures reject missing inputs without writing partial reports", async () => {
  const coverage = path.join(repositoryRoot, "dist/coverage");
  await mkdir(coverage, { recursive: true });
  const folder = await mkdtemp(path.join(coverage, "merge-contract-"));
  try {
    const destination = path.join(folder, "result.out");
    for (const args of [[], [destination]])
      await assert.rejects(invoke("scripts/merge-go-coverage.mjs", args), /Supply an output coverage path/);
    const left = path.join(folder, "left.out"),
      right = path.join(folder, "right.out");
    await writeFile(left, "mode: set\nexample/main.go:1.1,2.2 1 1\n");
    await writeFile(right, "mode: count\nexample/main.go:3.1,4.2 1 0\n");
    await invoke("scripts/merge-go-coverage.mjs", [destination, left, right]);
    assert.match(await readFile(destination, { encoding: "utf8" }), /example\/main.go:3.1,4.2 1 0/);
    const saved = await readFile(destination);
    await writeFile(right, "invalid input");
    await assert.rejects(invoke("scripts/merge-go-coverage.mjs", [destination, left, right]), /Invalid Go coverage/);
    assert.deepEqual(await readFile(destination), saved);
    await assert.rejects(
      invoke("scripts/test-coverage-c.mjs", [], { BIFOIL_LLVM_BIN: "relative" }),
      process.platform === "linux" ? /absolute bin directory/ : /requires Linux/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
