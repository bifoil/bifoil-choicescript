import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import {
  repositoryRoot,
  languageServerRoot,
  verifyLanguageServerSource,
  verifyNativeArtifact,
} from "../native-artifact.mjs";

test("source verification rejects malformed locks and propagates Git metadata failures", async (t) => {
  const lockFile = path.join(repositoryRoot, "vendor/bifoil-language-server.lock.json");
  const gitFile = path.join(languageServerRoot, ".git");
  const read = fs.readFile;
  const stat = fs.lstat;
  const lock = JSON.parse(await read(lockFile, "utf8"));
  let candidate = lock;
  let gitFailure;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "readFile", (file, ...args) =>
    file === lockFile ? Promise.resolve(JSON.stringify(candidate)) : read(file, ...args),
  );
  t.mock.method(fs, "lstat", (file, ...args) =>
    file === gitFile && gitFailure ? Promise.reject(gitFailure) : stat(file, ...args),
  );
  syncBuiltinESMExports();

  for (const changed of [
    { format: 2 },
    { repository: "https://example.invalid/native.git" },
    { module: "example.invalid/native" },
    { commit: null },
    { commit: "invalid" },
    { sourceSha256: null },
    { sourceSha256: "invalid" },
    { sourceSha256: "0".repeat(64) },
  ]) {
    candidate = { ...lock, ...changed };
    await assert.rejects(verifyLanguageServerSource(), /source differs/);
  }
  candidate = { ...lock, commit: "f".repeat(40) };
  await assert.rejects(verifyLanguageServerSource(), /submodule revision does not match/);
  candidate = lock;
  gitFailure = Object.assign(new Error("owned metadata permission failure"), { code: "EACCES" });
  await assert.rejects(verifyLanguageServerSource(), (error) => error === gitFailure);
  gitFailure = Object.assign(new Error("archive has no Git metadata"), { code: "ENOENT" });
  assert.deepEqual(await verifyLanguageServerSource(), lock);
});

test("native manifests enforce target executable names, toolchain identity and complete checksum fields", async (t) => {
  const target = `${process.platform}-${process.arch}`;
  const directory = path.join(repositoryRoot, "dist/native", target);
  const manifestFile = path.join(directory, "manifest.json");
  const windowsFile = path.join(repositoryRoot, "dist/native/win32-x64/manifest.json");
  const read = fs.readFile;
  const manifest = JSON.parse(await read(manifestFile, "utf8"));
  let candidate = manifest;
  let wrongWindowsExecutable = false;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "readFile", (file, ...args) => {
    if (wrongWindowsExecutable && file === windowsFile)
      return Promise.resolve(
        JSON.stringify({ ...manifest, target: "win32-x64", executable: "bifoil-language-server" }),
      );
    if (file === manifestFile) return Promise.resolve(JSON.stringify(candidate));
    return read(file, ...args);
  });
  syncBuiltinESMExports();
  for (const changed of [
    { format: 2 },
    { module: "example.invalid/native" },
    { target: "unsupported" },
    { executable: "other" },
    { toolchain: null },
    { toolchain: { version: "go0.0.0" } },
    { sourceSha256: "0".repeat(64) },
  ]) {
    candidate = { ...manifest, ...changed };
    await assert.rejects(verifyNativeArtifact(target), /does not match its current source and toolchain/);
  }
  for (const changed of [{ sha256: null }, { licenseSha256: null }, { sha256: "0".repeat(64) }]) {
    candidate = { ...manifest, ...changed };
    await assert.rejects(verifyNativeArtifact(target), /checksum mismatch/);
  }
  candidate = manifest;
  assert.equal((await verifyNativeArtifact(target)).manifest.sha256, manifest.sha256);
  wrongWindowsExecutable = true;
  await assert.rejects(verifyNativeArtifact("win32-x64"), /does not match its current source and toolchain/);
});
