/**
 * Provision checksum-pinned official Node archives from the repository root.
 * CLI: [target] defaults to the host; --all provisions every runtime-lock target.
 * Downloads/cache live under .cache/runtimes; extracted distribution files under dist/runtime.
 * Importing provision() supplies the same operation to packaging scripts.
 */
import { unzipSync } from "fflate";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostTool } from "./host-tools.mjs";

const lock = JSON.parse(await readFile("runtime-lock.json", { encoding: "utf8" }));

/** Keep verified existing executables untouched, including a runtime currently in use. */
async function install(file, data) {
  try {
    const existing = await readFile(file);
    if (existing.equals(typeof data === "string" ? Buffer.from(data) : data)) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(file, data);
}

/** Provision a locked target and return its absolute dist/runtime directory; reject unknown targets or bad hashes. */
export async function provision(requested) {
  const target = Object.keys(lock.archives).find((candidate) => candidate === requested);
  if (!target || !/^(?:win32|darwin|linux)-(?:x64|arm64)$/.test(target) || !Object.hasOwn(lock.archives, target))
    throw new Error("Unsupported platform");

  const archive = lock.archives[target];

  if (!archive) throw new Error(`Unsupported platform ${target}`);

  const dir = path.resolve(".cache/runtimes", target);
  await mkdir(dir, { recursive: true });

  const file = path.join(dir, archive.file);
  let bytes;

  try {
    bytes = await readFile(file);
  } catch {
    const response = await fetch(`https://nodejs.org/dist/${lock.version}/${archive.file}`);

    if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);

    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(file, bytes);
  }

  if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) throw new Error("Runtime checksum mismatch");

  const prefix = archive.file.replace(/\.(tar\.xz|zip)$/, "");
  const extracted = path.join(dir, prefix),
    out = path.resolve("dist/runtime", target);
  await mkdir(out, { recursive: true });

  const binary = target.startsWith("win32-") ? "node.exe" : "node";

  if (archive.file.endsWith(".zip")) {
    const needed = new Set([prefix + "/node.exe", prefix + "/LICENSE"]);
    const files = unzipSync(bytes, {
      filter: (entry) => needed.has(entry.name),
    });
    await install(path.join(out, binary), files[prefix + "/node.exe"]);
    await install(path.join(out, "NODE-LICENSE"), files[prefix + "/LICENSE"]);
  } else {
    execFileSync(await hostTool("tar"), ["-xf", file, "-C", dir, "--", prefix + "/bin/node", prefix + "/LICENSE"]);
    await install(path.join(out, binary), await readFile(path.join(extracted, "bin/node")));
    await install(path.join(out, "NODE-LICENSE"), await readFile(path.join(extracted, "LICENSE")));
  }

  if (!target.startsWith("win32-")) await chmod(path.join(out, binary), 0o755);
  await install(
    path.join(out, "provenance.json"),
    JSON.stringify(
      {
        version: lock.version,
        archive: archive.file,
        archiveSha256: archive.sha256,
        binarySha256: createHash("sha256")
          .update(await readFile(path.join(out, binary)))
          .digest("hex"),
      },
      null,
      2,
    ),
  );

  return out;
}

if (process.argv[1]?.endsWith("runtime.mjs"))
  for (const target of process.argv.includes("--all")
    ? Object.keys(lock.archives)
    : [process.argv[2] ?? `${process.platform}-${process.arch}`]) {
    console.log(`Preparing Node ${lock.version} for ${target}`);
    await provision(target);
  }
