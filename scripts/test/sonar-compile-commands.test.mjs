import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { wasmCompileCommands } from "../sonar-compile-commands.mjs";
import { repositoryRoot } from "../artifact-paths.mjs";
const run = promisify(execFile);
test("Sonar compiles the actual wasm32 source with the shipped ABI and flags", async () => {
  assert.throws(() => wasmCompileCommands("relative"), /absolute repository root/);
  const [entry] = wasmCompileCommands(repositoryRoot);
  const build = await readFile(path.join(repositoryRoot, "scripts/build-native.mjs"), "utf8");
  assert.equal(entry.file, path.join(repositoryRoot, "native/environment/environment.c"));
  assert.equal(entry.directory, path.resolve(repositoryRoot));
  for (const flag of entry.arguments.filter((argument) => argument.startsWith("-")))
    assert(build.includes(JSON.stringify(flag)), flag);
  await run(process.execPath, ["scripts/sonar-compile-commands.mjs"], { cwd: repositoryRoot, timeout: 10000 });
  assert.deepEqual(
    JSON.parse(await readFile(path.join(repositoryRoot, "dist/coverage/c/compile_commands.json"), "utf8")),
    [entry],
  );
});
