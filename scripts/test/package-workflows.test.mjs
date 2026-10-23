import { zipSync } from "fflate";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { repositoryRoot } from "../artifact-paths.mjs";

/** @type {typeof import("node:child_process").execFile.__promisify__} */
const run = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const invoke = (file, args = [], extra = {}) =>
  run(process.execPath, [file, ...args], { cwd: repositoryRoot, timeout: 90000, ...extra });

test("release provenance includes all locked targets, original notices, and verifiable checksums", async () => {
  const root = await mkdtemp(path.join(repositoryRoot, "dist/release-provenance-"));
  try {
    const targets = Object.keys(
      JSON.parse(await readFile(path.join(repositoryRoot, "runtime-lock.json"), { encoding: "utf8" })).archives,
    );
    const build = (extra) =>
      invoke("scripts/release-manifest.mjs", [root], { env: { ...process.env, GITHUB_SHA: "a".repeat(40), ...extra } });
    await assert.rejects(build(), /Missing package/);
    for (const target of targets)
      await writeFile(path.join(root, `bifoil-choicescript-${target}.vsix`), "Original package: " + target);
    await assert.rejects(build(), /one universal JetBrains ZIP/);
    await writeFile(path.join(root, "bifoil-choicescript-0.1.0.zip"), "Original installer");
    await assert.rejects(build({ GITHUB_SHA: "invalid" }), /verified source commit/);
    assert.match((await build({ GITHUB_RUN_ID: "original-run" })).stdout, /seven packages/);
    const manifest = JSON.parse(await readFile(path.join(root, "release-manifest.json"), { encoding: "utf8" }));
    assert.equal(manifest.commit, "a".repeat(40));
    assert.equal(manifest.validationRun, "original-run");
    assert.equal(manifest.artifacts.length, 7);
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(path.join(root, artifact.file));
      assert.equal(artifact.bytes, bytes.length);
      assert.equal(artifact.sha256, sha(bytes));
    }
    assert.match((await invoke("scripts/verify-release.mjs", [root])).stdout, /Verified/);
    assert.equal(
      await readFile(path.join(root, "BIFOIL_CHOICESCRIPT-LICENSE.txt"), { encoding: "utf8" }),
      await readFile(path.join(repositoryRoot, "LICENSE"), { encoding: "utf8" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VSIX extraction validates provenance and leaves the installed selection intact on failure", async () => {
  const folder = await mkdtemp(path.join(repositoryRoot, "dist/extraction-regression-"));
  const installed = path.join(repositoryRoot, ".cache/installed");
  await mkdir(installed, { recursive: true });
  const originalDirectories = new Set(await readdir(installed));
  const pointer = path.join(repositoryRoot, "dist/installed-extension.json");
  const previous = await readFile(pointer).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const target = process.platform + "-" + process.arch;
  const node = Buffer.from("Original inert runtime bytes"),
    native = Buffer.from("Original inert native bytes"),
    license = Buffer.from("Original license");
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, "runtime-lock.json"), { encoding: "utf8" }));
  const nativeName = process.platform === "win32" ? "bifoil-language-server.exe" : "bifoil-language-server";
  const base = `extension/server/native/${target}/`;
  const files = {
    "extension.vsixmanifest": Buffer.from(`<Identity TargetPlatform="${target}"/>`),
    "extension/package.json": Buffer.from('{"name":"original"}'),
    ["extension/runtime/" + (process.platform === "win32" ? "node.exe" : "node")]: node,
    "extension/runtime/provenance.json": Buffer.from(
      JSON.stringify({ archiveSha256: lock.archives[target].sha256, binarySha256: sha(node) }),
    ),
    [base + nativeName]: native,
    [base + "GO_LICENSE.txt"]: license,
    [base + "manifest.json"]: Buffer.from(
      JSON.stringify({ format: 1, target, executable: nativeName, sha256: sha(native), licenseSha256: sha(license) }),
    ),
    "extension/assets/": new Uint8Array(),
  };
  const artifact = path.join(folder, "original.vsix");
  const extract = () => invoke("scripts/extract-vsix.mjs", [artifact]);
  try {
    await writeFile(artifact, zipSync(files));
    assert.match((await extract()).stdout, /Verified and extracted/);
    const selection = JSON.parse(await readFile(pointer, { encoding: "utf8" }));
    assert.equal(
      await readFile(path.join(selection.path, "package.json"), { encoding: "utf8" }),
      '{"name":"original"}',
    );
    const selected = await readFile(pointer);
    await writeFile(artifact, zipSync({ ...files, [base + nativeName]: Buffer.from("tampered") }));
    await assert.rejects(extract(), /native checksum mismatch/);
    assert.deepEqual(await readFile(pointer), selected);
    assert.equal(
      (await readdir(installed)).filter((name) => !originalDirectories.has(name)).length,
      1,
      "failed extraction must release its staging directory",
    );
    await writeFile(artifact, zipSync({ ...files, "extension/runtime/provenance.json": Buffer.from("{}") }));
    await assert.rejects(extract(), /runtime checksum mismatch/);
    await writeFile(
      artifact,
      zipSync({ ...files, "extension.vsixmanifest": Buffer.from('<Identity TargetPlatform="wrong"/>') }),
    );
    await assert.rejects(extract(), /does not match this host/);
  } finally {
    if (previous) await writeFile(pointer, previous);
    else await rm(pointer, { force: true });
    for (const name of await readdir(installed))
      if (!originalDirectories.has(name)) await rm(path.join(installed, name), { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});
