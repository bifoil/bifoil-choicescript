import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { buildSync } from "esbuild";
import { repositoryRoot } from "../artifact-paths.mjs";
const run = promisify(execFile);

test("source-mapped child coverage preserves unexecuted functions and branch bodies", async () => {
  const directory = await mkdtemp(path.join(repositoryRoot, ".cache/coverage-probe-"));
  try {
    const source = path.join(directory, "probe.ts"),
      compiled = path.join(directory, "probe.cjs");
    const text = [
      "function choose(value: number) {",
      "  if (value === 1) {",
      '    return "chosen";',
      "  }",
      '  throw new Error("unexecuted branch");',
      "}",
      "function neverCalled() {",
      '  throw new Error("unexecuted function");',
      "}",
      'if (choose(1) !== "chosen") throw new Error("wrong result");',
      "globalThis.retainedForCoverage = neverCalled;",
    ].join("\n");
    await writeFile(source, text);
    buildSync({
      entryPoints: [source],
      outfile: compiled,
      platform: "node",
      format: "cjs",
      sourcemap: "inline",
      minify: true,
    });
    const raw = path.join(directory, "raw"),
      report = path.join(directory, "report");
    await mkdir(raw);
    await run(process.execPath, [compiled], { env: { ...process.env, NODE_V8_COVERAGE: raw } });
    const config = path.join(directory, "c8.json");
    await writeFile(
      config,
      JSON.stringify({
        include: ["**/probe.ts", "**/probe.cjs"],
        exclude: [],
        "experimental-monocart": true,
        "exclude-after-remap": true,
        reporter: ["lcovonly"],
        "temp-directory": raw,
        "reports-dir": report,
      }),
    );
    await run(
      process.execPath,
      [path.join(repositoryRoot, "node_modules/c8/bin/c8.js"), "report", "--config", config],
      { cwd: repositoryRoot },
    );
    const lcov = await readFile(path.join(report, "lcov.info"), "utf8");
    assert.match(lcov, /^DA:3,[1-9]\d*$/m, "executed return must have hits");
    assert.match(lcov, /^DA:5,0$/m, "unexecuted branch must remain uncovered");
    assert.match(lcov, /^DA:8,0$/m, "unexecuted function must remain uncovered");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
