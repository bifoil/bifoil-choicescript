import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectSources, sourceUri } from "../src/projects.js";

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
