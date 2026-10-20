import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { repositoryRoot } from "../artifact-paths.mjs";
const run = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test(
  "host IntelliJ resources verify both archives and server-only refresh retains the runtime",
  {
    skip:
      process.env.BIFOIL_TEST_PACKAGING !== "1" &&
      "Enable BIFOIL_TEST_PACKAGING=1 for installed-runtime packaging validation",
  },
  async () => {
    const invoke = (args) =>
      run(process.execPath, ["scripts/package-intellij.mjs", ...args], { cwd: repositoryRoot, timeout: 120000 });
    const base = path.join(repositoryRoot, "editors/intellij/src/main/resources/bundle");
    assert.match((await invoke(["--current"])).stdout, /Prepared verified IntelliJ/);
    const manifest = JSON.parse(await readFile(path.join(base, "manifest.json"), "utf8"));
    const nodeName = `node-${process.platform}-${process.arch}.zip`;
    assert.deepEqual(Object.keys(manifest).sort(), [nodeName, "server.zip"].sort());
    for (const [name, expected] of Object.entries(manifest))
      assert.equal(sha(await readFile(path.join(base, name))), expected);
    const server = unzipSync(await readFile(path.join(base, "server.zip")));
    assert(server["tool-broker.cjs"]);
    assert(!Object.keys(server).some((name) => name.endsWith(".map")));
    const nodeZip = path.join(base, nodeName),
      modified = (await stat(nodeZip)).mtimeMs;
    assert.match((await invoke(["--server-only"])).stdout, /Prepared verified IntelliJ/);
    const refreshed = JSON.parse(await readFile(path.join(base, "manifest.json"), "utf8"));
    assert.equal(refreshed[nodeName], manifest[nodeName]);
    assert.equal((await stat(nodeZip)).mtimeMs, modified);
    assert.equal(sha(await readFile(path.join(base, "server.zip"))), refreshed["server.zip"]);
  },
);
