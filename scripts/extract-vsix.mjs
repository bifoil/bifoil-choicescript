/**
 * Extract argv[2] (or the host VSIX) into a new .cache/installed directory.
 * Check the host target and packaged runtime provenance, then record its path in
 * dist/installed-extension.json for smoke/editor tests. Extraction is retained for reuse;
 * this script does not launch an editor or validate every package content.
 */
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactPath } from "./artifact-paths.mjs";

const target = `${process.platform}-${process.arch}`;
const artifact = await artifactPath(process.argv[2] ?? `dist/packages/bifoil-choicescript-${target}.vsix`);
if (!artifact.toLowerCase().endsWith(".vsix")) throw new Error("Select a VSIX artifact");
const files = unzipSync(new Uint8Array(await readFile(artifact)));
const descriptor = Buffer.from(files["extension.vsixmanifest"]).toString();

if (!descriptor.includes(`TargetPlatform="${target}"`)) throw new Error("VSIX target does not match this host");

await mkdir(".cache/installed", { recursive: true });

const destination = await mkdtemp(path.resolve(".cache/installed/extension-"));

let installed = false;
try {
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith("extension/")) continue;

    const output = path.resolve(destination, name);

    if (!output.startsWith(destination + path.sep)) throw new Error("Invalid archive path");

    if (name.endsWith("/")) {
      await mkdir(output, { recursive: true });
      continue;
    }

    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
  }

  const extension = path.join(destination, "extension");
  const runtime = path.join(extension, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const provenance = JSON.parse(
    await readFile(path.join(extension, "runtime/provenance.json"), {
      encoding: "utf8",
    }),
  );
  const lock = JSON.parse(await readFile("runtime-lock.json", { encoding: "utf8" }));

  if (
    provenance.archiveSha256 !== lock.archives[target].sha256 ||
    createHash("sha256")
      .update(await readFile(runtime))
      .digest("hex") !== provenance.binarySha256
  )
    throw new Error("Packaged runtime checksum mismatch");

  const nativeDirectory = path.join(extension, "server/native", target);
  const nativeManifest = JSON.parse(await readFile(path.join(nativeDirectory, "manifest.json"), "utf8"));
  const nativeName = process.platform === "win32" ? "bifoil-language-server.exe" : "bifoil-language-server";
  if (nativeManifest.format !== 1 || nativeManifest.target !== target || nativeManifest.executable !== nativeName)
    throw new Error("Packaged native target mismatch");
  for (const [file, expected] of [
    [nativeName, nativeManifest.sha256],
    ["GO_LICENSE.txt", nativeManifest.licenseSha256],
  ])
    if (
      !/^[a-f0-9]{64}$/.test(expected ?? "") ||
      createHash("sha256")
        .update(await readFile(path.join(nativeDirectory, file)))
        .digest("hex") !== expected
    )
      throw new Error("Packaged native checksum mismatch: " + file);
  await chmod(path.join(nativeDirectory, nativeName), 0o755);
  await chmod(runtime, 0o755);
  await mkdir("dist", { recursive: true });
  await writeFile(
    "dist/installed-extension.json",
    JSON.stringify({ path: extension, target, artifact: path.resolve(artifact) }, null, 2),
  );
  installed = true;
  console.log(`Verified and extracted ${target}: ${extension}`);
} finally {
  if (!installed) await rm(destination, { recursive: true, force: true });
}
