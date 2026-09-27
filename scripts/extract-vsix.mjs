import { readFile, writeFile, mkdir, mkdtemp, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { unzipSync } from "fflate";
const target = `${process.platform}-${process.arch}`;
const artifact = process.argv[2] ?? `dist/packages/branchlight-${target}.vsix`;
const files = unzipSync(new Uint8Array(await readFile(artifact)));
const descriptor = Buffer.from(files["extension.vsixmanifest"]).toString();
if (!descriptor.includes(`TargetPlatform="${target}"`))
  throw new Error("VSIX target does not match this host");
await mkdir(".cache/installed", { recursive: true });
const destination = await mkdtemp(path.resolve(".cache/installed/extension-"));
for (const [name, bytes] of Object.entries(files)) {
  if (!name.startsWith("extension/")) continue;
  const output = path.resolve(destination, name);
  if (!output.startsWith(destination + path.sep))
    throw new Error("Invalid archive path");
  if (name.endsWith("/")) {
    await mkdir(output, { recursive: true });
    continue;
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, bytes);
}
const extension = path.join(destination, "extension");
const runtime = path.join(
  extension,
  "runtime",
  process.platform === "win32" ? "node.exe" : "node",
);
const provenance = JSON.parse(
  await readFile(path.join(extension, "runtime/provenance.json"), "utf8"),
);
const lock = JSON.parse(await readFile("runtime-lock.json", "utf8"));
if (
  provenance.archiveSha256 !== lock.archives[target].sha256 ||
  createHash("sha256")
    .update(await readFile(runtime))
    .digest("hex") !== provenance.binarySha256
)
  throw new Error("Packaged runtime checksum mismatch");
await chmod(runtime, 0o755);
await mkdir("dist", { recursive: true });
await writeFile(
  "dist/installed-extension.json",
  JSON.stringify(
    { path: extension, target, artifact: path.resolve(artifact) },
    null,
    2,
  ),
);
console.log(`Verified and extracted ${target}: ${extension}`);
