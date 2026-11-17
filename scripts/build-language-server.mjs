/** Build the pinned standalone submodule directly into this repository's artifact cache. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { languageServerRoot, nativeTargets, repositoryRoot, verifyLanguageServerSource } from "./native-artifact.mjs";

export async function buildLanguageServer(requested, run = execFileSync) {
  const target = Object.keys(nativeTargets).find((candidate) => candidate === requested);
  if (!target) throw new Error("Unsupported native server target: " + requested);
  await verifyLanguageServerSource();
  run(
    process.execPath,
    [path.join(languageServerRoot, "scripts/build.mjs"), target, path.join(repositoryRoot, "dist/native")],
    { cwd: languageServerRoot, stdio: "inherit" },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildLanguageServer(process.argv[2] ?? `${process.platform}-${process.arch}`);
}
