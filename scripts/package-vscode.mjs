/**
 * Package already-built adapter/server output for argv[2] or the current host.
 * Provisions the pinned runtime, replaces editors/vscode/runtime, and writes a target VSIX.
 * Run from the repository root after build; this shared staging path makes concurrent
 * target packaging unsafe. Cross-packaging is not target-host execution validation.
 */
import { createVSIX } from "@vscode/vsce";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { provision } from "./runtime.mjs";
import { stageNativeArtifacts } from "./native-artifact.mjs";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
await stageNativeArtifacts("editors/vscode/server", [target]);
const runtime = await provision(target);
await rm("editors/vscode/runtime", { recursive: true, force: true });
await cp(runtime, "editors/vscode/runtime", { recursive: true });
await mkdir("dist/packages", { recursive: true });
await createVSIX({
  cwd: path.resolve("editors/vscode"),
  packagePath: path.resolve(`dist/packages/bifoil-choicescript-${target}.vsix`),
  target,
  dependencies: false,
  githubBranch: "main",
  skipLicense: false,
});
