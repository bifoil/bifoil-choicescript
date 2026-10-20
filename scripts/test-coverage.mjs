/** Collect source-mapped functional coverage, then enforce latency separately without instrumentation. */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactPath, repositoryRoot } from "./artifact-paths.mjs";
import { normalizeCoverage } from "./coverage-report.mjs";

const directory = await artifactPath("dist/coverage");
await mkdir(directory, { recursive: true });
const coverage = path.join(directory, "javascript.lcov");
const env = { ...process.env };
delete env.NODE_V8_COVERAGE;
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["node_modules/c8/bin/c8.js", process.execPath, "scripts/coverage-tests.mjs"]);
const raw = await readFile(path.join(directory, "javascript/lcov.info"), "utf8");
await writeFile(path.join(directory, "javascript.raw.lcov"), raw);
const report = normalizeCoverage(raw);
await writeFile(coverage, report.lcov);
await writeFile(
  path.join(directory, "mapping-warnings.json"),
  JSON.stringify({ unmappedBranches: report.unmappedBranches, excludedFiles: report.excludedFiles }, null, 2) + "\n",
);
console.log(
  `Recorded ${report.unmappedBranches.length} V8 branches without source locations in dist/coverage/mapping-warnings.json.`,
);

run(["--import", "tsx", "--test", "--test-isolation=none", "packages/server/test/performance.test.ts"]);
