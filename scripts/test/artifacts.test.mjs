import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { artifactPath, confinedPath, releaseFile, repositoryRoot } from "../artifact-paths.mjs";
import { hostTool } from "../host-tools.mjs";
import { provision } from "../runtime.mjs";

/** @type {typeof import("node:child_process").execFile.__promisify__} */
const run = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("artifact arguments cannot select source directories or escape through links", async () => {
  await assert.rejects(artifactPath("vendor/choicescript"), /artifact path/i);
  await assert.rejects(artifactPath("../other"), /escapes/);
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil artifact roots "));
  try {
    await mkdir(path.join(root, "allowed"));
    await mkdir(path.join(root, "outside"));
    await symlink(
      path.join(root, "outside"),
      path.join(root, "allowed/link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(confinedPath(path.join(root, "allowed"), "link/output"), /links/);
    await assert.rejects(confinedPath(path.join(root, "allowed"), "../outside/output"), /escapes/);
    for (const name of ["../secret", "..\\secret", "C:secret", ".", "..", "file\nname"])
      await assert.rejects(releaseFile(root, name), /asset name/);
    await assert.rejects(confinedPath(root, "allowed/.. /outside"), /nonportable/);
    await assert.rejects(confinedPath(root, "new/.. /outside"), /nonportable/);
    await assert.rejects(confinedPath(root, "new/NUL.txt"), /nonportable/);
    assert.equal(await confinedPath(root, "new/file"), path.join(root, "new/file"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact inputs reject empty and control-character paths and release assets must be regular files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil release asset lifecycle "));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const value of [null, "", "\0hidden", "new/file\rname", "new/file\nname"])
    await assert.rejects(confinedPath(root, value), /Invalid artifact path/);
  const asset = path.join(root, "future.vsix");
  assert.equal(await releaseFile(root, "future.vsix"), asset);
  await writeFile(asset, "Original release-asset fixture.");
  assert.equal(await releaseFile(root, "future.vsix"), asset);
  await rm(asset);
  await mkdir(asset);
  await assert.rejects(releaseFile(root, "future.vsix"), /must be regular files/);
  assert((await lstat(asset)).isDirectory(), "rejected caller-owned directories must remain intact");
});

test("runtime targets reject prototype keys, path traversal and command options before provisioning", async () => {
  for (const target of [
    "__proto__",
    "constructor",
    "../outside",
    "linux-x64/../../outside",
    "--checkpoint-action=exec=bad",
    null,
  ])
    await assert.rejects(provision(target), /Unsupported platform/);
});

test("host tool overrides require an existing absolute executable", async () => {
  const previous = process.env.BIFOIL_GIT;
  try {
    process.env.BIFOIL_GIT = "git";
    await assert.rejects(hostTool("git"), /absolute path/);
    process.env.BIFOIL_GIT = process.execPath;
    assert.equal(await hostTool("git"), process.execPath);
    await assert.rejects(hostTool("unknown"), /Unsupported/);
  } finally {
    if (previous === undefined) delete process.env.BIFOIL_GIT;
    else process.env.BIFOIL_GIT = previous;
  }
});

test("host utility resolution checks file type and executable permissions in explicit installation layouts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil host layout "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "programs/Git/cmd/git.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "original executable fixture", { mode: 0o755 });
  const environment = { ProgramFiles: path.join(root, "programs"), SystemRoot: path.join(root, "system") };
  assert.equal(await hostTool("git", { platform: "win32", environment }), executable);
  const powershell = path.join(environment.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  await mkdir(path.dirname(powershell), { recursive: true });
  await writeFile(powershell, "original executable fixture", { mode: 0o755 });
  assert.equal(await hostTool("powershell", { platform: "win32", environment }), powershell);
  await assert.rejects(hostTool("tar", { platform: "win32", environment }), /Install tar/);
  await assert.rejects(hostTool("unknown", { platform: "win32", environment: {} }), /Unsupported/);
  await assert.rejects(hostTool("git", { environment: { BIFOIL_GIT: root } }), /Install git/);
  if (process.platform !== "win32") {
    await assert.rejects(hostTool("git", { environment: { BIFOIL_GIT: path.join(executable, "child") } }), /ENOTDIR/);
    await chmod(executable, 0o600);
    await assert.rejects(hostTool("git", { environment: { BIFOIL_GIT: executable } }), /Install git/);
  }
});

test("release verification rejects duplicate artifacts and malformed metadata after checksum verification", async () => {
  const dist = path.join(repositoryRoot, "dist");
  await mkdir(dist, { recursive: true });
  const root = await mkdtemp(path.join(dist, "release-regression-"));
  try {
    const targets = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
    const artifacts = [];
    for (const file of [
      ...targets.map((target) => `bifoil-choicescript-${target}.vsix`),
      "bifoil-choicescript-0.1.0.zip",
    ]) {
      const bytes = Buffer.from("Original integrity test: " + file);
      await writeFile(path.join(root, file), bytes);
      artifacts.push({ file, bytes: bytes.length, sha256: sha(bytes) });
    }
    const manifest = { commit: "0".repeat(40), targets, artifacts };
    const prepare = async (data) => {
      await writeFile(path.join(root, "release-manifest.json"), JSON.stringify(data));
      const names = [...artifacts.map((item) => item.file), "release-manifest.json"];
      const sums = [];
      for (const file of names) sums.push(`${sha(await readFile(path.join(root, file)))}  ${file}`);
      await writeFile(path.join(root, "SHA256SUMS.txt"), sums.join("\n") + "\n");
    };
    const verify = () => run(process.execPath, ["scripts/verify-release.mjs", root], { cwd: repositoryRoot });
    await prepare(manifest);
    assert.match((await verify()).stdout, /Verified 8 downloaded release assets/);

    await prepare({ ...manifest, artifacts: [artifacts[0], ...artifacts.slice(0, 6)] });
    await assert.rejects(verify(), /Invalid release artifact/);
    await prepare({ ...manifest, commit: "unsafe\nmetadata" });
    await assert.rejects(verify(), /Invalid release manifest/);
    await prepare({ ...manifest, targets: Array(6).fill("linux-x64") });
    await assert.rejects(verify(), /Invalid release targets/);
    await prepare(manifest);
    await writeFile(path.join(root, "SHA256SUMS.txt"), `${"0".repeat(64)}  ../outside\n`);
    await assert.rejects(verify(), /Invalid release asset name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
