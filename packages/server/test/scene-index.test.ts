import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { classification, startServer, waitFor } from "./helpers.js";
import { discoverProjects, projectSources } from "@bifoil/choicescript-tooling";

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
