import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { classification, startServer, waitFor } from "./helpers.js";
import { discoverProjects, projectSources } from "@bifoil/choicescript-tooling";
import { SceneIndex, SummaryCache } from "../src/scene-index.js";

test("scene inventory invalidation retires removed projections, failures and URI aliases", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil index ownership "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "startup.txt");
  await writeFile(file, "*ending\n");
  const [project] = await discoverProjects([root]);
  const index = new SceneIndex(project);
  t.after(() => index.dispose());
  const uri = pathToFileURL(file).href;
  const retired = pathToFileURL(path.join(root, "removed.txt")).href;
  index.cached.set(uri, "current projection");
  index.cached.set(retired, "retired projection");
  index.failed.set(uri, "current failure");
  index.failed.set(retired, "retired failure");
  index.stamps.set(uri, 1);
  index.stamps.set(retired, 2);
  const sources = await index.inventory();
  assert.equal(await index.inventory(), sources);
  assert.equal(index.cached.has(retired), false);
  assert.equal(index.failed.has(retired), false);
  assert.equal(index.stamps.has(retired), false);
  assert.equal(index.cached.has(uri), true);
  index.invalidate(uri.replace("startup", "%73tartup"));
  assert.equal(index.cached.has(uri), false);
  assert.equal(index.failed.has(uri), false);
  assert.equal(index.stamps.has(uri), false);
  const before = index.generation;
  const pending = index.inventory();
  index.invalidate();
  assert.equal(index.generation, before + 1);
  assert.deepEqual(await pending, await index.inventory());
  const directory = await index.cacheDirectory();
  assert.equal(await index.cacheDirectory(), directory);
  await writeFile(path.join(directory, "owned.cache"), "original fixture");
  await index.dispose();
  await assert.rejects(readFile(path.join(directory, "owned.cache")), /ENOENT/);
});

test("summary cache evicts by byte budget and recency without retaining oversized replacements", () => {
  const cache = new SummaryCache(4);
  const first = new Uint8Array([1, 2]),
    second = new Uint8Array([3, 4]),
    third = new Uint8Array([5, 6]);
  cache.set("first", first);
  cache.set("second", second);
  assert.equal(cache.get("first"), first);
  cache.set("third", third);
  assert.equal(cache.get("second"), undefined);
  assert.equal(cache.get("first"), first);
  cache.set("first", new Uint8Array(5));
  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.get("third"), third);
  cache.delete("missing");
  cache.delete("third");
  assert.equal(cache.get("third"), undefined);
});

test("source inventories retain buffer aliases and unsaved scenes without loading disk text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bifoil inventory Ω "));

  try {
    await mkdir(path.join(dir, "scenes"));

    const file = path.join(dir, "scenes/startup.txt");
    await writeFile(file, "*create value 7\n*ending");

    const [project] = await discoverProjects([dir]);
    const canonical = pathToFileURL(file).href,
      alias = canonical.replace("startup", "%73tartup");
    const newUri = pathToFileURL(path.join(dir, "scenes/new.txt")).href;
    const sources = await projectSources(project, [
      { uri: alias, text: "buffer value", version: 7 },
      { uri: newUri, text: "unsaved", version: 1 },
    ]);

    assert.equal(sources.length, 2);
    assert.equal(sources.find((s) => s.file === file)?.buffer?.text, "buffer value");
    assert.equal(sources.find((s) => s.uri === newUri)?.buffer?.text, "unsaved");
    assert(!sources.some((s) => "text" in s));
    assert.equal(await readFile(file, "utf8"), "*create value 7\n*ending");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "indexed closed scenes retain cross-scene dialogue, rename and disk invalidation",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bifoil indexed Ω "));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      const sceneDir = path.join(dir, "scenes");
      await mkdir(sceneDir);

      const source =
        "*create score 7\n*create implicit_control_flow true\n*scene_list\n  startup\n  chapter\n  ending\n*goto_scene chapter";
      const chapter =
        '*label entry\n*temp local 1\nShe said "Hello,\n' +
        "Still speaking without closing.\n".repeat(300) +
        '*set score "changed"\n*goto_scene ending';
      const ending = 'World."\n*print score\n*ending';

      for (const [scene, text] of [
        ["startup", source],
        ["chapter", chapter],
        ["ending", ending],
      ])
        await writeFile(path.join(sceneDir, scene + ".txt"), text);

      const uri = pathToFileURL(path.join(sceneDir, "ending.txt")).href;
      const h = (server = await startServer([dir]));
      h.open(uri, ending);
      await waitFor(
        () => h.rpc.sendRequest("choicescript/indexStatus"),
        (states: any) => states.length === 1 && states[0].complete,
      );

      const tokens: any = await h.rpc.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } });

      assert.equal(classification(tokens, h.legend, 0, 0), "dialogue");
      assert.equal(classification(tokens, h.legend, 1, 8), "stringVariable");

      const params = { textDocument: { uri }, position: { line: 1, character: 8 } };
      const edits: any = await h.rpc.sendRequest("textDocument/rename", { ...params, newName: "renamed_score" });

      assert.equal(Object.keys(edits.changes).length, 3);

      const changed = chapter.replace('*set score "changed"', "*set score true");
      const chapterUri = pathToFileURL(path.join(sceneDir, "chapter.txt")).href;
      await writeFile(path.join(sceneDir, "chapter.txt"), changed);
      await h.rpc.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri: chapterUri, type: 2 }] });
      await waitFor(async () => {
        const status: any = await h.rpc.sendRequest("choicescript/indexStatus");
        const value: any = await h.rpc.sendRequest("textDocument/hover", params);
        return status[0]?.complete && value?.contents?.value.includes("Type: " + String.fromCharCode(96) + "boolean");
      });

      const updated: any = await h.rpc.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } });

      assert.equal(classification(updated, h.legend, 1, 8), "booleanVariable");
    } finally {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
