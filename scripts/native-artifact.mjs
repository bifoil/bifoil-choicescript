/** Native artifact provenance and staging, independent of editor APIs and old checkouts. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const nativeTargets = {
  "win32-x64": ["windows", "amd64"],
  "win32-arm64": ["windows", "arm64"],
  "darwin-x64": ["darwin", "amd64"],
  "darwin-arm64": ["darwin", "arm64"],
  "linux-x64": ["linux", "amd64"],
  "linux-arm64": ["linux", "arm64"],
};
export const fileSha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

/** Hash every compiled project input in a deterministic, path-separated stream. */
export async function nativeSourceDigest() {
  const files = [
    "go.mod",
    "native/toolchain.json",
    "packages/core/src/commands.json",
    "scripts/build-language-server.mjs",
    "scripts/native-artifact.mjs",
  ];
  for (const directory of ["native/server", "packages/core/src"])
    for (const entry of await readdir(path.join(repositoryRoot, directory), { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))
        files.push(directory + "/" + entry.name);
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    hash
      .update(file)
      .update("\0")
      .update(await readFile(path.join(repositoryRoot, file)))
      .update("\0");
  return hash.digest("hex");
}

/** Verify source freshness, host target and exact bytes before a cached executable is reused. */
export async function verifyNativeArtifact(target) {
  if (!Object.hasOwn(nativeTargets, target)) throw new Error("Unsupported native target: " + target);
  const directory = path.join(repositoryRoot, "dist/native", target);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  const sdk = JSON.parse(await readFile(path.join(repositoryRoot, "native/toolchain.json"), "utf8"));
  const executable = "bifoil-language-server" + (nativeTargets[target][0] === "windows" ? ".exe" : "");
  if (
    manifest.format !== 1 ||
    manifest.target !== target ||
    manifest.executable !== executable ||
    manifest.toolchain?.version !== sdk.version ||
    manifest.sourceSha256 !== (await nativeSourceDigest())
  )
    throw new Error("Native server does not match its current source and toolchain: " + target);
  for (const [file, expected] of [
    [executable, manifest.sha256],
    ["GO_LICENSE.txt", manifest.licenseSha256],
  ]) {
    const info = await lstat(path.join(directory, file));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !/^[a-f0-9]{64}$/.test(expected ?? "") ||
      (await fileSha256(path.join(directory, file))) !== expected
    )
      throw new Error("Native artifact checksum mismatch: " + target + "/" + file);
  }
  return { directory, manifest };
}

/** Build missing/stale output using the pinned installed SDK; never download a toolchain. */
export async function ensureNativeArtifact(target) {
  try {
    return await verifyNativeArtifact(target);
  } catch {
    execFileSync(process.execPath, [path.join(repositoryRoot, "scripts/build-language-server.mjs"), target], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    return verifyNativeArtifact(target);
  }
}

/** Replace only this generated bundle's native directory after every requested target verifies. */
export async function stageNativeArtifacts(bundle, targets) {
  const artifacts = [];
  for (const target of targets) artifacts.push({ target, ...(await ensureNativeArtifact(target)) });
  await mkdir(bundle, { recursive: true });
  const staging = await mkdtemp(path.join(bundle, ".native-stage-"));
  try {
    for (const { target, directory, manifest } of artifacts) {
      const destination = path.join(staging, target);
      await mkdir(destination);
      for (const file of [manifest.executable, "manifest.json", "GO_LICENSE.txt"])
        await cp(path.join(directory, file), path.join(destination, file));
    }
    await rm(path.join(bundle, "native"), { recursive: true, force: true });
    await rename(staging, path.join(bundle, "native"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
