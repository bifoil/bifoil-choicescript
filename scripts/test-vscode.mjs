import { runTests } from "@vscode/test-electron";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installedExtension } from "./installed-extension.mjs";

// vscode-test-electron 2.5.2 invokes cmd.exe on Windows; it does not quote
// caller-provided paths. Preserve each path as one argument, including spaces.
const launchPath = (value) => (process.platform === "win32" ? `"${value}"` : value);
const profile = await mkdtemp(path.join(os.tmpdir(), "bifoil-choicescript-editor-"));
const reports = path.resolve("dist/test-results/editor");
await rm(reports, { recursive: true, force: true });
await mkdir(reports, { recursive: true });
try {
  const game = path.join(profile, "game Ω");
  await cp(path.resolve("fixtures/dialogue"), game, { recursive: true });
  await runTests({
    version: "1.109.0",
    vscodeExecutablePath: process.env.BIFOIL_CHOICESCRIPT_VSCODE_EXECUTABLE,
    extensionDevelopmentPath: launchPath(await installedExtension()),
    extensionTestsPath: launchPath(path.resolve("editors/vscode/test/smoke.cjs")),
    extensionTestsEnv: { BIFOIL_CHOICESCRIPT_TEST_REPORTS: reports },
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
  const workflow = JSON.parse(await readFile(path.join(reports, "workflows.json"), { encoding: "utf8" }));
  await writeFile(
    path.join(reports, "result.json"),
    JSON.stringify({
      status: "passed",
      platform: process.platform,
      arch: process.arch,
      editor: workflow.editor,
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
