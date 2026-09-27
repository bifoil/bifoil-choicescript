import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export async function writeDependencyNotices(builds) {
  const packages = new Map();
  for (const build of builds)
    for (const input of Object.keys(build.metafile.inputs)) {
      if (!input.includes("node_modules")) continue;
      let dir = path.dirname(path.resolve(input));
      for (let i = 0; i < 12; i++) {
        try {
          const info = JSON.parse(
            await readFile(path.join(dir, "package.json"), "utf8"),
          );
          if (info.name && info.version) {
            packages.set(info.name + "@" + info.version, { info, dir });
            break;
          }
        } catch {}
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  let text = "# Bundled JavaScript dependency notices\n\n";
  const inventory = [];
  for (const [name, { info, dir }] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const licenses = (await readdir(dir)).filter((f) =>
      /^(license|licence|notice|copying)(?:[.-]|$)/i.test(f),
    );
    if (!licenses.length)
      throw new Error("Missing dependency license for " + name);
    text += "## " + name + "\n\nLicense: " + info.license + "\n\n";
    const hashes = {};
    for (const file of licenses) {
      const body = await readFile(path.join(dir, file), "utf8");
      text += "### " + file + "\n\n" + body + "\n\n";
      hashes[file] = createHash("sha256").update(body).digest("hex");
    }
    inventory.push({
      name: info.name,
      version: info.version,
      license: info.license,
      notices: hashes,
    });
  }
  await writeFile("dist/server/DEPENDENCY-NOTICES.md", text);
  await writeFile(
    "dist/server/dependencies.json",
    JSON.stringify(inventory, null, 2) + "\n",
  );
}
