import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { repositoryRoot } from "../artifact-paths.mjs";
const run = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hook = pathToFileURL(path.join(repositoryRoot, "scripts/test/support/packaging-boundary.mjs")).href;
async function isolated(body) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil packaging contract Ω "));
  const invoke = (script, args = [], environment = {}) =>
    run(process.execPath, ["--import", hook, path.join(repositoryRoot, "scripts", script), ...args], {
      cwd: root,
      env: { ...process.env, BIFOIL_PACKAGE_CONTRACT: "success", ...environment },
      timeout: 20000,
    });
  try {
    for (const folder of [
      "prepared-runtime",
      "dist/server/nested",
      "packages/core/src",
      "native/environment",
      "fixtures/dialogue/scenes",
    ])
      await mkdir(path.join(root, folder), { recursive: true });
    await writeFile(
      path.join(root, "runtime-lock.json"),
      JSON.stringify({ archives: { "win32-x64": {}, "linux-x64": {} } }),
    );
    await writeFile(path.join(root, "prepared-runtime/node"), "Original runtime");
    await writeFile(path.join(root, "dist/server/nested/worker.cjs"), "Original worker");
    await writeFile(path.join(root, "dist/server/nested/worker.cjs.map"), "Original sourcemap");
    await body(root, invoke);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("IntelliJ preparation hashes real archives, strips server maps and preserves runtimes on server-only refresh", async () => {
  await isolated(async (root, invoke) => {
    await invoke("package-intellij.mjs", ["--current"]);
    const base = path.join(root, "editors/intellij/src/main/resources/bundle");
    const first = JSON.parse(await readFile(path.join(base, "manifest.json"), "utf8"));
    const nodeName = "node-" + process.platform + "-" + process.arch + ".zip";
    assert.deepEqual(Object.keys(first).sort(), [nodeName, "server.zip"].sort());
    for (const [name, digest] of Object.entries(first))
      assert.equal(hash(await readFile(path.join(base, name))), digest);
    const server = unzipSync(await readFile(path.join(base, "server.zip")));
    assert(server["nested/worker.cjs"]);
    assert(!server["nested/worker.cjs.map"]);
    const runtime = unzipSync(await readFile(path.join(base, nodeName)));
    assert.equal(Buffer.from(runtime.node).toString(), "Original runtime");
    await writeFile(path.join(root, "dist/server/nested/worker.cjs"), "Changed worker");
    await invoke("package-intellij.mjs", ["--server-only"]);
    const second = JSON.parse(await readFile(path.join(base, "manifest.json"), "utf8"));
    assert.equal(first[nodeName], second[nodeName]);
    assert.notEqual(first["server.zip"], second["server.zip"]);
    await invoke("package-intellij.mjs");
    const all = JSON.parse(await readFile(path.join(base, "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(all).sort(), ["node-linux-x64.zip", "node-win32-x64.zip", "server.zip"]);
  });
});

test("VS Code and all-target wrappers retain target selection, packaging arguments and checksums", async () => {
  await isolated(async (root, invoke) => {
    for (const target of [undefined, "linux-x64"]) {
      await invoke("package-vscode.mjs", target ? [target] : []);
      const options = JSON.parse(await readFile(path.join(root, "vsix-options.json"), "utf8"));
      assert.equal(options.target, target ?? process.platform + "-" + process.arch);
      assert.equal(options.dependencies, false);
      assert.equal(options.skipLicense, false);
      assert.equal(await readFile(path.join(root, "editors/vscode/runtime/node"), "utf8"), "Original runtime");
    }
    await assert.rejects(
      invoke("package-vscode.mjs", [], { BIFOIL_PACKAGE_CONTRACT: "provision-failure" }),
      /Original provisioning failure/,
    );
    await invoke("package-all.mjs");
    const checksums = await readFile(path.join(root, "dist/packages/SHA256SUMS.txt"), "utf8");
    for (const target of ["win32-x64", "linux-x64"]) {
      const name = "bifoil-choicescript-" + target + ".vsix";
      assert(checksums.includes(hash(await readFile(path.join(root, "dist/packages", name))) + "  " + name));
    }
    await assert.rejects(
      invoke("package-all.mjs", [], { BIFOIL_PACKAGE_CONTRACT: "child-failure" }),
      /Original child failure/,
    );
  });
});

test("portable native build records verified bytes and releases owned staging on child failure", async () => {
  await isolated(async (root, invoke) => {
    await writeFile(path.join(root, "native/environment/environment.c"), "Original source\r\n");
    await invoke("build-native.mjs");
    const generated = await readFile(path.join(root, "packages/core/src/environment-binary.ts"), "utf8");
    assert(generated.includes(hash("Original source\n")));
    assert(generated.includes(hash(Buffer.from([0, 97, 115, 109]))));
    const saved = generated;
    await assert.rejects(
      invoke("build-native.mjs", [], { BIFOIL_PACKAGE_CONTRACT: "child-failure" }),
      /Original child failure/,
    );
    assert.equal(await readFile(path.join(root, "packages/core/src/environment-binary.ts"), "utf8"), saved);
    const call = JSON.parse(await readFile(path.join(root, "child-call.json"), "utf8"));
    assert(call.args.includes("--target=wasm32"));
    await assert.rejects(readFile(path.dirname(call.args.at(-1))), /ENOENT/);
  });
});

test("installed smoke and editor wrappers retain extracted paths and record both success and failure", async () => {
  await isolated(async (root, invoke) => {
    await invoke("test-bundle.mjs");
    const call = JSON.parse(await readFile(path.join(root, "child-call.json"), "utf8"));
    assert(call.executable.includes("original extracted extension"));
    assert(call.options.env.BIFOIL_CHOICESCRIPT_BUNDLE_ROOT.endsWith("server"));
    await invoke("test-vscode.mjs");
    const reports = path.join(root, "dist/test-results/editor");
    let result = JSON.parse(await readFile(path.join(reports, "result.json"), "utf8"));
    assert.equal(result.status, "passed");
    assert.equal(result.packaged, true);
    assert.equal(result.editor, "original test editor");
    await invoke("test-vscode.mjs", [], { BIFOIL_CHOICESCRIPT_EXTENSION_PATH: "/explicit" });
    result = JSON.parse(await readFile(path.join(reports, "result.json"), "utf8"));
    assert.equal(result.packaged, false);
    assert.equal(result.selection, "explicit development override");
    await assert.rejects(
      invoke("test-vscode.mjs", [], { BIFOIL_PACKAGE_CONTRACT: "editor-failure" }),
      /Original editor failure/,
    );
    assert.match(await readFile(path.join(reports, "failure.txt"), "utf8"), /Original editor failure/);
  });
});

test("installed selection honors explicit overrides and refuses another host's manifest", async () => {
  await isolated(async (root) => {
    const script =
      "import {installedExtension} from " +
      JSON.stringify(new URL("../installed-extension.mjs", import.meta.url).href) +
      ";console.log(await installedExtension())";
    const invoke = (environment = {}) =>
      run(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: root,
        env: { ...process.env, BIFOIL_CHOICESCRIPT_EXTENSION_PATH: "", ...environment },
        timeout: 10000,
      });
    const pointer = path.join(root, "dist/installed-extension.json");
    await writeFile(
      pointer,
      JSON.stringify({ target: process.platform + "-" + process.arch, path: "original selection" }),
    );
    assert.equal((await invoke()).stdout.trim(), "original selection");
    await writeFile(pointer, JSON.stringify({ target: "unrelated-host", path: "must not select" }));
    await assert.rejects(invoke(), /another host/);
    assert.equal(
      (await invoke({ BIFOIL_CHOICESCRIPT_EXTENSION_PATH: "explicit selection" })).stdout.trim(),
      path.resolve(root, "explicit selection"),
    );
  });
});
