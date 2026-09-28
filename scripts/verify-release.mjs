import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "release");
const sums = (await readFile(path.join(directory, "SHA256SUMS.txt"), { encoding: "utf8" })).trim().split("\n");
const checked = new Set();
for (const line of sums) {
  const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
  if (!match || path.basename(match[2]) !== match[2] || checked.has(match[2]))
    throw new Error("Invalid checksum entry");
  const actual = createHash("sha256")
    .update(await readFile(path.join(directory, match[2])))
    .digest("hex");
  if (actual !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
  checked.add(match[2]);
}
for (const file of await readdir(directory))
  if (file !== "SHA256SUMS.txt" && !checked.has(file)) throw new Error(`Unrecorded asset: ${file}`);
const manifest = JSON.parse(await readFile(path.join(directory, "release-manifest.json"), { encoding: "utf8" }));
if (manifest.artifacts.length !== 7 || manifest.targets.length !== 6) throw new Error("Incomplete release manifest");
for (const artifact of manifest.artifacts) {
  if (!checked.has(artifact.file)) throw new Error(`Missing release artifact: ${artifact.file}`);
  const bytes = await readFile(path.join(directory, artifact.file));
  if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw new Error(`Manifest mismatch: ${artifact.file}`);
}
console.log(`Verified ${checked.size} downloaded assets for ${manifest.commit}.`);
