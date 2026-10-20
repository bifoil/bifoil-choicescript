import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { buildCoverageTests } from "../coverage-build.mjs";
import { repositoryRoot } from "../artifact-paths.mjs";
import { mergeGoCoverage } from "../merge-go-coverage.mjs";
const run = promisify(execFile);
const invoke = (file, args = [], extra = {}) =>
  run(process.execPath, [file, ...args], { cwd: repositoryRoot, timeout: 90000, ...extra });

test("Go coverage combines real hits without inflating counts or accepting stale blocks", () => {
  const block = "example/core.go:1.1,3.2";
  const result = mergeGoCoverage([
    `mode: set\n${block} 2 0\n`,
    `mode: atomic\n${block} 2 7\nexample/windows.go:2.1,4.1 1 1\n`,
  ]);
  assert.equal(result, `mode: set\n${block} 2 1\nexample/windows.go:2.1,4.1 1 1\n`);
  assert.throws(
    () => mergeGoCoverage([`mode: set\n${block} 2 1\n`, `mode: count\n${block} 3 0\n`]),
    /different source blocks/,
  );
  for (const invalid of ["", "mode: invalid\n", "mode: set\ninvalid\n", `mode: set\n${block} 2 -1\n`])
    assert.throws(() => mergeGoCoverage([invalid]), /Invalid Go coverage/);
});

test("read-only corpus CLI distinguishes syntax errors from invalid plugin ranges", async () => {
  const [entry] = await buildCoverageTests(["scripts/test-corpus.mjs"], { liveEntryURLs: true });
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil original corpus Ω "));
  try {
    const good = path.join(root, "good"),
      broken = path.join(root, "broken");
    for (const folder of [good, broken]) await mkdir(path.join(folder, "scenes"), { recursive: true });
    const source = "*create value 1\nOriginal narrative.\n*print value\n*ending";
    await writeFile(path.join(good, "scenes/startup.txt"), source);
    await writeFile(path.join(broken, "scenes/startup.txt"), '*create value 1\n*set value "unfinished\n*print value');
    assert.match((await invoke(entry, ["--help"])).stdout, /Read-only analysis/);
    await assert.rejects(invoke(entry), (error) => error.code === 1 && /Usage:/.test(error.stdout));
    const { stdout } = await invoke(entry, [good]);
    const success = JSON.parse(stdout.trim());
    assert.equal(success.files, 1);
    assert.equal(success.errors, 0);
    assert.equal(success.invalidTokens, 0);
    assert.equal(success.invalidDiagnostics, 0);
    await assert.rejects(invoke(entry, ["--details", broken]), (error) => {
      const result = JSON.parse(error.stdout.trim());
      assert.equal(result.invalidTokens, 0);
      assert.equal(result.invalidDiagnostics, 0);
      assert(result.errors > 0);
      assert(result.locations.some((location) => location.code === "expression-string" && location.line === 2));
      return error.code === 1;
    });
    await assert.rejects(invoke(entry, ["--worker", path.join(good, "scenes/startup.txt")]), /Command failed/);
    assert.equal(await readFile(path.join(good, "scenes/startup.txt"), "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic benchmark CLI reports complete original scenes and deletes disposable sources", async () => {
  const [entry] = await buildCoverageTests(["scripts/benchmark-large-game.mjs"]);
  await mkdir(path.join(repositoryRoot, ".bifoil-choicescript/development"), { recursive: true });
  const folder = await mkdtemp(path.join(repositoryRoot, ".bifoil-choicescript/development/benchmark-test-"));
  try {
    const report = path.join(folder, "report.json");
    let exitCode = 0;
    try {
      await invoke(entry, ["2", "1000", report]);
    } catch (error) {
      exitCode = error.code;
    }
    const result = JSON.parse(await readFile(report, "utf8"));
    assert.equal(result.completed, exitCode === 0);
    if (exitCode !== 0) {
      assert.equal(exitCode, 1);
      assert.match(result.failure, /memory sampling ended without any samples/);
      assert.equal(result.memory.peakMiB, null);
    }
    assert.equal(result.words, 2000);
    assert.equal(result.scenes, 3);
    assert.deepEqual(result.errors, []);
    assert(result.measurements.length > 0);
    await assert.rejects(invoke(entry, ["1", "1000", report]), /Command failed/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("source build and native smoke retain runnable host artifacts", async () => {
  const built = await invoke("scripts/build.mjs");
  assert.match(built.stdout, /Built shared server/);
  const smoke = await invoke("scripts/smoke-bundle.cjs");
  assert.match(smoke.stdout, /Bundled runtime smoke passed/);
});
