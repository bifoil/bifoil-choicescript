import { execFileSync } from "node:child_process";
import path from "node:path";
import { installedExtension } from "./installed-extension.mjs";

const extension = await installedExtension();
const node = path.join(extension, "runtime", process.platform === "win32" ? "node.exe" : "node");
execFileSync(node, [path.resolve("scripts/smoke-bundle.cjs")], {
  stdio: "inherit",
  env: {
    ...process.env,
    BRANCHLIGHT_SERVER_PATH: path.join(extension, "server/server.cjs"),
  },
});
