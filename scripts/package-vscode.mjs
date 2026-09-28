import { createVSIX } from "@vscode/vsce";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { provision } from "./runtime.mjs";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const runtime = await provision(target);
await rm("editors/vscode/runtime", { recursive: true, force: true });
await cp(runtime, "editors/vscode/runtime", { recursive: true });
await mkdir("dist/packages", { recursive: true });
await createVSIX({
  cwd: path.resolve("editors/vscode"),
  packagePath: path.resolve(`dist/packages/branchlight-${target}.vsix`),
  target,
  dependencies: false,
  githubBranch: "main",
  skipLicense: false,
});
