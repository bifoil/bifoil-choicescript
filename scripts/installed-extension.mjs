/**
 * Resolve an extracted test extension from an explicit environment override or the
 * last extraction manifest. The override is caller-owned; only manifest selection here
 * checks the host target. This does not rebuild or install the extension.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Select the package under test without silently falling back to the source adapter. */
export async function installedExtension() {
  if (process.env.BIFOIL_CHOICESCRIPT_EXTENSION_PATH)
    return path.resolve(process.env.BIFOIL_CHOICESCRIPT_EXTENSION_PATH);

  const selected = JSON.parse(await readFile("dist/installed-extension.json", { encoding: "utf8" }));

  if (selected.target !== `${process.platform}-${process.arch}`)
    throw new Error("Installed test extension belongs to another host");

  return selected.path;
}
