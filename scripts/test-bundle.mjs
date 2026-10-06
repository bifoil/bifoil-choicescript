/**
 * Run the bundle smoke harness with the selected extracted package's Node and server.
 * Selection comes from installedExtension(); a source-tree Node launch would not prove
 * that the installer contains a runnable bundled runtime.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { installedExtension } from "./installed-extension.mjs";

const extension = await installedExtension();
const node = path.join(extension, "runtime", process.platform === "win32" ? "node.exe" : "node");
execFileSync(node, [path.resolve("scripts/smoke-bundle.cjs")], {
  stdio: "inherit",
  env: {
    ...process.env,
    BIFOIL_CHOICESCRIPT_SERVER_PATH: path.join(extension, "server/server.cjs"),
  },
});
