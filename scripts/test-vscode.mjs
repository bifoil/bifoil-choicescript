import { runTests } from "@vscode/test-electron";
import path from "node:path";
await runTests({
  version: "1.109.0",
  extensionDevelopmentPath: path.resolve(
    process.env.BRANCHLIGHT_EXTENSION_PATH ?? "editors/vscode",
  ),
  extensionTestsPath: path.resolve("editors/vscode/test/smoke.cjs"),
  launchArgs: [
    path.resolve("fixtures/dialogue"),
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    "--no-sandbox",
  ],
});
