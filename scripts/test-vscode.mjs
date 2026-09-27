import { runTests } from "@vscode/test-electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { installedExtension } from "./installed-extension.mjs";
const profile = await mkdtemp(path.join(os.tmpdir(), "branchlight-editor-"));
const reports = path.resolve("dist/test-results/editor");
await mkdir(reports, { recursive: true });
try {
  await runTests({
    version: "1.109.0",
    extensionDevelopmentPath: await installedExtension(),
    extensionTestsPath: path.resolve("editors/vscode/test/smoke.cjs"),
    extensionTestsEnv: { BRANCHLIGHT_TEST_REPORTS: reports },
    launchArgs: [
      path.resolve("fixtures/dialogue"),
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      "--user-data-dir",
      profile,
      "--extensions-dir",
      path.join(profile, "extensions"),
    ],
  });
  await writeFile(
    path.join(reports, "result.json"),
    JSON.stringify({
      status: "passed",
      platform: process.platform,
      arch: process.arch,
      editor: "1.109.0",
      packaged: true,
    }),
  );
} catch (error) {
  await writeFile(
    path.join(reports, "failure.txt"),
    String(error.stack ?? error),
  );
  throw error;
} finally {
  const { cp } = await import("node:fs/promises");
  await cp(path.join(profile, "logs"), path.join(reports, "logs"), {
    recursive: true,
  }).catch(() => {});
}
