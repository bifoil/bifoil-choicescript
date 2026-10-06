import { readFile } from "node:fs/promises";
import path from "node:path";

export async function installedExtension() {
  if (process.env.BIFOIL_CHOICESCRIPT_EXTENSION_PATH) return path.resolve(process.env.BIFOIL_CHOICESCRIPT_EXTENSION_PATH);
  const selected = JSON.parse(await readFile("dist/installed-extension.json", { encoding: "utf8" }));
  if (selected.target !== `${process.platform}-${process.arch}`)
    throw new Error("Installed test extension belongs to another host");
  return selected.path;
}
