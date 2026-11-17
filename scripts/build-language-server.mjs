/** Build the pinned standalone submodule directly into this repository's artifact cache. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { languageServerRoot, repositoryRoot, verifyLanguageServerSource } from "./native-artifact.mjs";

await verifyLanguageServerSource();
execFileSync(
  process.execPath,
  [
    path.join(languageServerRoot, "scripts/build.mjs"),
    process.argv[2] ?? `${process.platform}-${process.arch}`,
    path.join(repositoryRoot, "dist/native"),
  ],
  { cwd: languageServerRoot, stdio: "inherit" },
);
