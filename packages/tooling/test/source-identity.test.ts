import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

test("file-backed tool captures preserve unsaved bytes and remain separate from disk", async () => {
  const { ToolRunner } = await import("@bifoil/choicescript-tooling");
  const { fileURLToPath } = await import("node:url");
  const { mkdir, readFile, symlink } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil captured Ω "));
  const runner = new ToolRunner(fileURLToPath(new URL("../../../vendor/choicescript", import.meta.url)), () => {});
  let stage: string | undefined;
  try {
    const sceneDir = path.join(root, "scenes");
    await mkdir(sceneDir);
    const file = path.join(sceneDir, "startup.txt");
    await writeFile(file, "Disk text.\n*ending\n");
    const textFile = path.join(root, "capture");
    const bytes = Buffer.from('Unsaved Ω "dialogue."\r\n*ending\r\n');
    await writeFile(textFile, bytes);
    const project = { id: pathToFileURL(sceneDir).href, name: "fixture", root, sceneDir, assetDir: sceneDir };
    stage = await runner.stage(project, [{ uri: pathToFileURL(file).href, version: 3, textFile }]);
    assert.deepEqual(await readFile(path.join(stage, "web/mygame/scenes/startup.txt")), bytes);
    assert.equal(await readFile(file, "utf8"), "Disk text.\n*ending\n");
    const alias = path.join(root, "capture-link");
    try {
      await symlink(textFile, alias);
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await assert.rejects(
      runner.stage(project, [{ uri: pathToFileURL(file).href, version: 3, textFile: alias }]),
      /regular file/,
    );
  } finally {
    await runner.dispose();
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
