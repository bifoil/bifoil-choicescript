import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildLanguageServer } from "../build-language-server.mjs";
import { nativeTargets, languageServerRoot, repositoryRoot } from "../native-artifact.mjs";

const run = promisify(execFile);

test("native build dispatch accepts only the six pinned targets after checking source identity", async () => {
  const calls = [];
  for (const target of Object.keys(nativeTargets))
    await buildLanguageServer(target, (executable, arguments_, options) =>
      calls.push({ executable, arguments_, options }),
    );
  assert.equal(calls.length, 6);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.executable, process.execPath);
    assert.deepEqual(call.arguments_, [
      path.join(languageServerRoot, "scripts/build.mjs"),
      Object.keys(nativeTargets)[index],
      path.join(repositoryRoot, "dist/native"),
    ]);
    assert.equal(call.options.cwd, languageServerRoot);
    assert.equal(call.options.stdio, "inherit");
  }
  const unexpected = () => assert.fail("Invalid target launched a child process");
  for (const value of ["__proto__", "constructor", "../outside", "--eval", "linux-x64/../../outside", null])
    await assert.rejects(buildLanguageServer(value, unexpected), /Unsupported native server target/);
});
test("native build CLI rejects invalid command arguments before starting the Go build", async () => {
  await assert.rejects(
    run(process.execPath, ["scripts/build-language-server.mjs", "--eval"], {
      cwd: repositoryRoot,
      env: { ...process.env, BIFOIL_GO: "must-not-run" },
    }),
    (error) => error.code !== 0 && /Unsupported native server target/.test(error.stderr),
  );
});
