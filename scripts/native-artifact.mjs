/** Native artifact provenance and staging, independent of editor APIs and old checkouts. */
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostTool } from "./host-tools.mjs";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const languageServerRoot = path.join(repositoryRoot, "vendor/bifoil-language-server");
const provenance = await import("../vendor/bifoil-language-server/scripts/provenance.mjs").catch((cause) => {
  throw new Error(
    "Initialize vendor/bifoil-language-server with git submodule update --init --recursive before building.",
    { cause },
  );
});
export const { fileSha256, nativeSourceDigest, nativeTargets } = provenance;

/** Reject a different checkout or modified production inputs before building or reusing executable output. */
export async function verifyLanguageServerSource() {
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, "vendor/bifoil-language-server.lock.json"), "utf8"));
  if (
    lock.format !== 1 ||
    lock.repository !== "https://github.com/bifoil/bifoil-language-server.git" ||
    lock.module !== provenance.moduleName ||
    !/^[a-f0-9]{40}$/.test(lock.commit ?? "") ||
    !/^[a-f0-9]{64}$/.test(lock.sourceSha256 ?? "") ||
    lock.sourceSha256 !== (await nativeSourceDigest())
  )
    throw new Error(
      "Language server source differs from vendor/bifoil-language-server.lock.json; initialize the pinned submodule or deliberately update its pin and digest together.",
    );
  const gitFile = await lstat(path.join(languageServerRoot, ".git")).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (gitFile) {
    const git = await hostTool("git");
    const revision = execFileSync(git, ["-C", languageServerRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (revision !== lock.commit) throw new Error("Language server submodule revision does not match its lock file.");
  }
  return lock;
}

/** Verify source freshness, host target and exact bytes before a cached executable is reused. */
export async function verifyNativeArtifact(target) {
  const lock = await verifyLanguageServerSource();
  if (!Object.hasOwn(nativeTargets, target)) throw new Error("Unsupported native target: " + target);
  const directory = path.join(repositoryRoot, "dist/native", target);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), { encoding: "utf8" }));
  const sdk = JSON.parse(await readFile(path.join(languageServerRoot, "toolchain.json"), { encoding: "utf8" }));
  const executable = "bifoil-language-server" + (nativeTargets[target][0] === "windows" ? ".exe" : "");
  if (
    manifest.format !== 1 ||
    manifest.module !== lock.module ||
    manifest.target !== target ||
    manifest.executable !== executable ||
    manifest.toolchain?.version !== sdk.version ||
    manifest.sourceSha256 !== lock.sourceSha256
  )
    throw new Error("Native server does not match its current source and toolchain: " + target);
  await Promise.all(
    [
      [executable, manifest.sha256],
      ["GO_LICENSE.txt", manifest.licenseSha256],
    ].map(async ([file, expected]) => {
      const info = await lstat(path.join(directory, file));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        !/^[a-f0-9]{64}$/.test(expected ?? "") ||
        (await fileSha256(path.join(directory, file))) !== expected
      )
        throw new Error("Native artifact checksum mismatch: " + target + "/" + file);
    }),
  );
  return { directory, manifest };
}

/** Build missing/stale output using the pinned installed SDK; never download a toolchain. */
export async function ensureNativeArtifact(target) {
  await verifyLanguageServerSource();
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

/** Drain owned staging writes before cleanup, including after the first failed copy. */
async function completeOperations(operations) {
  const results = await Promise.allSettled(operations);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

/** Replace only this generated bundle's native directory after every requested target verifies. */
export async function stageNativeArtifacts(bundle, targets) {
  const artifacts = await completeOperations(
    targets.map(async (target) => ({ target, ...(await ensureNativeArtifact(target)) })),
  );
  await mkdir(bundle, { recursive: true });
  const staging = await mkdtemp(path.join(bundle, ".native-stage-"));
  try {
    await completeOperations(
      artifacts.map(async ({ target, directory, manifest }) => {
        const destination = path.join(staging, target);
        await mkdir(destination);
        await completeOperations(
          [manifest.executable, "manifest.json", "GO_LICENSE.txt"].map((file) =>
            cp(path.join(directory, file), path.join(destination, file)),
          ),
        );
      }),
    );
    await rm(path.join(bundle, "native"), { recursive: true, force: true });
    await rename(staging, path.join(bundle, "native"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
