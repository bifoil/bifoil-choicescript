import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectSources, sourceUri } from "@bifoil/choicescript-tooling";

test("source inventories preserve exact case collisions and reject ambiguous aliases", () => {
  const upper = "file:///C:/story/Chapter.txt";
  const lower = "file:///C:/story/chapter.txt";
  assert.equal(sourceUri([upper, lower], upper), upper);
  assert.equal(sourceUri([upper, lower], lower), lower);
  assert.equal(sourceUri([upper, lower], "file:///C:/story/CHAPTER.txt"), undefined);

  if (process.platform === "win32") {
    assert.equal(sourceUri([upper], lower), upper);
    assert.equal(sourceUri([upper, lower], "file:///c%3A/story/Chapter.txt"), upper);
    assert.equal(sourceUri([upper, lower], "file:///c%3A/story/chapter.txt"), lower);
  }
});

test("unsaved source aliases deduplicate without merging distinct filename case", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil unsaved Ω "));
  try {
    await writeFile(path.join(root, "startup.txt"), "Original.");
    const project = { id: pathToFileURL(root).href, name: "fixture", root, sceneDir: root, assetDir: root };
    const uri = pathToFileURL(path.join(root, "new.txt")).href;
    const alias = uri.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase());
    assert.notEqual(uri, alias);
    const sources = await projectSources(project, [
      { uri, text: "First.", version: 1 },
      { uri: alias, text: "Latest.", version: 2 },
    ]);
    assert.equal(sources.length, 2);
    assert.equal(sources.find((source) => source.buffer)?.buffer?.text, "Latest.");
    const upper = pathToFileURL(path.join(root, "New.txt")).href;
    const separate = await projectSources(project, [
      { uri, text: "Lower.", version: 1 },
      { uri: upper, text: "Upper.", version: 1 },
    ]);
    assert.equal(separate.length, 3);
    assert.deepEqual(
      separate
        .filter((source) => source.buffer)
        .map((source) => source.buffer!.text)
        .sort(),
      ["Lower.", "Upper."],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
