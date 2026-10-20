/**
 * Check a downloaded release directory against its checksum list and artifact manifest.
 * Reject missing, duplicate, unrecorded, or mismatched files. This verifies internal
 * integrity, not authenticity of the supplied manifest or native-editor acceptance.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { artifactPath, releaseFile } from "./artifact-paths.mjs";

const directory = await artifactPath(process.argv[2] ?? "release");
const sums = (await readFile(await releaseFile(directory, "SHA256SUMS.txt"), { encoding: "utf8" })).trim().split("\n");
const checked = new Set();

for (const line of sums) {
  const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);

  if (!match || checked.has(match[2])) throw new Error("Invalid checksum entry");

  const actual = createHash("sha256")
    .update(await readFile(await releaseFile(directory, match[2])))
    .digest("hex");

  if (actual !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);

  checked.add(match[2]);
}

for (const file of await readdir(directory))
  if (file !== "SHA256SUMS.txt" && !checked.has(file)) throw new Error(`Unrecorded asset: ${file}`);

const manifest = JSON.parse(
  await readFile(await releaseFile(directory, "release-manifest.json"), { encoding: "utf8" }),
);

if (
  !manifest ||
  !Array.isArray(manifest.artifacts) ||
  manifest.artifacts.length !== 7 ||
  !Array.isArray(manifest.targets) ||
  manifest.targets.length !== 6 ||
  !/^[a-f0-9]{40}$/.test(manifest.commit ?? "")
)
  throw new Error("Invalid release manifest");
const targets = new Set(["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]);
if (new Set(manifest.targets).size !== 6 || manifest.targets.some((target) => !targets.has(target)))
  throw new Error("Invalid release targets");
const artifacts = new Set();

for (const artifact of manifest.artifacts) {
  if (
    !artifact ||
    typeof artifact.file !== "string" ||
    artifacts.has(artifact.file) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")
  )
    throw new Error("Invalid release artifact");
  artifacts.add(artifact.file);
  if (!checked.has(artifact.file)) throw new Error(`Missing release artifact: ${artifact.file}`);

  const bytes = await readFile(await releaseFile(directory, artifact.file));

  if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw new Error(`Manifest mismatch: ${artifact.file}`);
}

console.log(`Verified ${checked.size} downloaded release assets.`);
