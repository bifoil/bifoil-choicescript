import { runTests } from "@vscode/test-electron";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installedExtension } from "./installed-extension.mjs";

// vscode-test-electron 2.5.2 invokes cmd.exe on Windows; it does not quote
// caller-provided paths. Preserve each path as one argument, including spaces.
const launchPath = (value) => (process.platform === "win32" ? `"${value}"` : value);
const profile = await mkdtemp(path.join(os.tmpdir(), "branchlight-editor-"));
const reports = path.resolve("dist/test-results/editor");
await mkdir(reports, { recursive: true });
try {
  const game = path.join(profile, "game Ω");
  await cp(path.resolve("fixtures/dialogue"), game, { recursive: true });
  await runTests({
    version: "1.109.0",
    vscodeExecutablePath: process.env.BRANCHLIGHT_VSCODE_EXECUTABLE,
    extensionDevelopmentPath: launchPath(await installedExtension()),
    extensionTestsPath: launchPath(path.resolve("editors/vscode/test/smoke.cjs")),
    extensionTestsEnv: { BRANCHLIGHT_TEST_REPORTS: reports },
    launchArgs: [
      launchPath(game),
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      "--user-data-dir",
      launchPath(profile),
      "--extensions-dir",
      launchPath(path.join(profile, "extensions")),
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
  await writeFile(path.join(reports, "failure.txt"), String(error.stack ?? error));
  throw error;
} finally {
  await cp(path.join(profile, "logs"), path.join(reports, "logs"), {
    recursive: true,
  }).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
