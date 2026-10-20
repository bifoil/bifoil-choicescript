/** Compile functional fixtures inside the coverage process, then collect all test subprocesses. */
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./artifact-paths.mjs";
import { buildCoverageTests } from "./coverage-build.mjs";

const files = [];
for (const root of [
  "packages/protocol/test",
  "packages/core/test",
  "packages/tooling/test",
  "packages/server/test",
  "scripts/test",
  "editors/vscode/test",
])
  for (const name of await readdir(path.join(repositoryRoot, root)))
    if (/\.test\.(?:ts|mjs)$/.test(name) && name !== "performance.test.ts") files.push(root + "/" + name);
const compiled = await buildCoverageTests(files);
const result = spawnSync(
  process.execPath,
  [
    "--enable-source-maps",
    "--test",
    "--test-isolation=none",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    ...compiled,
  ],
  { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
