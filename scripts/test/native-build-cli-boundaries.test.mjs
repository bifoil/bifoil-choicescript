import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { repositoryRoot } from "../artifact-paths.mjs";

const run = promisify(execFile);

test("anonymous module imports do not dispatch the native build CLI", async () => {
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await import("./scripts/build-language-server.mjs"); process.stdout.write("Original import completed\\n");',
    ],
    { cwd: repositoryRoot },
  );
  assert.equal(stdout, "Original import completed\n");
});

test("native build CLI selects the host target before reporting an unavailable explicit SDK", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bifoil native CLI boundary "));
  try {
    await assert.rejects(
      run(process.execPath, ["scripts/build-language-server.mjs"], {
        cwd: repositoryRoot,
        env: { ...process.env, BIFOIL_GO: path.join(directory, "missing-go") },
      }),
      (error) => error.code !== 0 && /ENOENT/.test(error.stderr) && !/Unsupported native server target/.test(error.stderr),
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
