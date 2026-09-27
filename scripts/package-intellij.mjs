import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { zipSync } from "fflate";
import { provision } from "./runtime.mjs";
const base = "editors/intellij/src/main/resources/bundle";
await mkdir(base, { recursive: true });
async function zipDir(source, name) {
  const files = {};
  async function walk(dir, prefix = "") {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix + file.name;
      if (file.isDirectory()) await walk(path.join(dir, file.name), rel + "/");
      else
        files[rel] = new Uint8Array(await readFile(path.join(dir, file.name)));
    }
  }
  await walk(source);
  const buffer = zipSync(files, { level: 6 });
  await writeFile(path.join(base, name), buffer);
  return createHash("sha256").update(buffer).digest("hex");
}
const serverOnly = process.argv.includes("--server-only");
const manifest = serverOnly
  ? JSON.parse(await readFile(path.join(base, "manifest.json"), "utf8"))
  : {};
manifest["server.zip"] = await zipDir("dist/server", "server.zip");
const lock = JSON.parse(await readFile("runtime-lock.json", "utf8"));
for (const target of serverOnly
  ? []
  : process.argv.includes("--current")
    ? [`${process.platform}-${process.arch}`]
    : Object.keys(lock.archives)) {
  const dir = await provision(target);
  manifest[`node-${target}.zip`] = await zipDir(dir, `node-${target}.zip`);
}
await writeFile(
  path.join(base, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(
  "Prepared verified IntelliJ runtime resources. Run editors/intellij/gradlew buildPlugin verifyPlugin.",
);
