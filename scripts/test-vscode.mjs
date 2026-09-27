import { runTests } from "@vscode/test-electron";
import { mkdir, mkdtemp, writeFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { installedExtension } from "./installed-extension.mjs";
const profile = await mkdtemp(path.join(os.tmpdir(), "branchlight-editor-"));
const reports = path.resolve("dist/test-results/editor");
await mkdir(reports, { recursive: true });
try {
  const game = path.join(profile, "game Ω");
  await cp(path.resolve("fixtures/dialogue"), game, { recursive: true });
  await runTests({
    version: "1.109.0",
    vscodeExecutablePath: process.env.BRANCHLIGHT_VSCODE_EXECUTABLE,
    extensionDevelopmentPath: await installedExtension(),
    extensionTestsPath: path.resolve("editors/vscode/test/smoke.cjs"),
    extensionTestsEnv: { BRANCHLIGHT_TEST_REPORTS: reports },
    launchArgs: [
      game,
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
  await cp(path.join(profile, "logs"), path.join(reports, "logs"), {
    recursive: true,
  }).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
