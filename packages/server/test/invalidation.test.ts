import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { classification, startServer, waitFor } from "./helpers.js";

test(
  "LSP rapid edits invalidate workspace symbols and never republish obsolete versions",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bifoil-choicescript edits Ω "));
    await mkdir(path.join(dir, "scenes"));
    const file = path.join(dir, "scenes/startup.txt"),
      uri = pathToFileURL(file).href;
    await writeFile(file, "*create score 1\n*print score");
    const h = await startServer([dir]);
    try {
      h.open(uri, "*create score 1\n*print score");
      await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === 1));
      h.change(uri, "*create replacement 2\n*print replacement", 2);
      assert.deepEqual(
        await h.rpc.sendRequest("workspace/symbol", { query: "score" }),
        [],
        "obsolete workspace symbols must be hidden immediately",
      );
      h.change(uri, Array.from({ length: 20000 }, () => "A large paragraph.").join("\n"), 3);
      await new Promise((r) => setTimeout(r, 160));
      for (let version = 4; version <= 20; version++)
        h.change(uri, version === 20 ? "*create final_value true\n*print final_value" : '*print "broken', version);
      const final = await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === 20));
      assert.deepEqual(final.diagnostics, []);
      const index = h.diagnostics.indexOf(final);
      await new Promise((r) => setTimeout(r, 300));
      assert(h.diagnostics.slice(index).every((d) => d.uri !== uri || d.version === 20));
      const params = {
        textDocument: { uri },
        position: { line: 1, character: 9 },
      };
      const completion: any = await h.rpc.sendRequest("textDocument/completion", params);
      assert(completion.some((c: any) => c.label === "final_value"));
      assert(!completion.some((c: any) => c.label === "score"));
      const edit: any = await h.rpc.sendRequest("textDocument/rename", {
        ...params,
        newName: "renamed",
      });
      assert.equal(edit.changes[uri].length, 2);
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "LSP disk edits, buffer close, configuration and multi-game discovery invalidate dependencies",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bifoil-choicescript projects Ω "));
    for (const game of ["one", "two"]) {
      await mkdir(path.join(dir, game, "scenes"), { recursive: true });
      await writeFile(
        path.join(dir, game, "scenes/startup.txt"),
        `*create value ${game === "one" ? "1" : '"other"'}\n*print value`,
      );
    }
    const one = pathToFileURL(path.join(dir, "one/scenes/startup.txt")).href,
      two = pathToFileURL(path.join(dir, "two/scenes/startup.txt")).href;
    const h = await startServer([dir]);
    const tokens = (uri: string) =>
      h.rpc.sendRequest<{ data: number[] }>("textDocument/semanticTokens/full", {
        textDocument: { uri },
      });
    const watched = (uri: string, type: number) =>
      h.rpc.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri, type }],
      });
    try {
      await waitFor(
        () => h.rpc.sendRequest<any[]>("choicescript/projects"),
        (p) => p.length === 2,
      );
      await waitFor(
        () => tokens(one),
        (t) => classification(t, h.legend, 1, 8) === "numberVariable",
      );
      await waitFor(
        () => tokens(two),
        (t) => classification(t, h.legend, 1, 8) === "stringVariable",
      );
      h.open(one, "*create value true\n*print value", 1);
      await waitFor(
        () => tokens(one),
        (t) => classification(t, h.legend, 1, 8) === "booleanVariable",
      );
      await h.rpc.sendNotification("textDocument/didClose", {
        textDocument: { uri: one },
      });
      await waitFor(
        () => tokens(one),
        (t) => classification(t, h.legend, 1, 8) === "numberVariable",
      );
      const helper = path.join(dir, "one/scenes/helper.txt"),
        helperUri = pathToFileURL(helper).href;
      await writeFile(path.join(dir, "one/scenes/startup.txt"), '"Open\n*goto_scene helper');
      await writeFile(helper, 'Closed."\nOutside');
      await watched(one, 2);
      await watched(helperUri, 1);
      await waitFor(
        () => tokens(helperUri),
        (t) => classification(t, h.legend, 0, 0) === "dialogue",
      );
      await writeFile(helper, "Still open");
      await watched(helperUri, 2);
      await waitFor(
        () => h.diagnostics.filter((d) => d.uri === one).at(-1),
        (d) => d?.diagnostics.some((x: any) => x.code === "quote-unclosed"),
      );
      await h.rpc.sendNotification("workspace/didChangeConfiguration", {
        settings: { bifoil: { choicescript: { quoteWarnings: false } } },
      });
      await waitFor(
        () => h.diagnostics.filter((d) => d.uri === one).at(-1),
        (d) => d && d.diagnostics.length === 0,
      );
      await rm(helper);
      await watched(helperUri, 3);
      await waitFor(
        () => tokens(helperUri),
        (t) => t.data.length === 0,
      );
      await mkdir(path.join(dir, "one/alternate"));
      await writeFile(path.join(dir, "one/alternate/startup.txt"), "New scene root.");
      const config = path.join(dir, "one/choicescript.json");
      await writeFile(config, JSON.stringify({ scenes: "alternate" }));
      await watched(pathToFileURL(config).href, 1);
      await waitFor(
        () => h.rpc.sendRequest<any[]>("choicescript/projects"),
        (p) => p.length === 2 && p.some((x) => x.sceneDir.endsWith("alternate")),
      );
      await waitFor(
        () => tokens(one),
        (t) => t.data.length === 0,
      );
      await waitFor(
        () => tokens(two),
        (t) => classification(t, h.legend, 1, 8) === "stringVariable",
      );
      const edit: any = await h.rpc.sendRequest("textDocument/rename", {
        textDocument: { uri: two },
        position: { line: 1, character: 8 },
        newName: "second_value",
      });
      assert.deepEqual(Object.keys(edit.changes), [two]);
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("LSP project discovery retains rootUri-only client compatibility", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bifoil-choicescript legacy root Ω "));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await mkdir(path.join(dir, "scenes"));
    await writeFile(path.join(dir, "scenes/startup.txt"), "*create score 1\n*print score");
    server = await startServer([dir], { legacyRootUri: true });
    const rpc = server.rpc;
    const projects = await waitFor(
      () => rpc.sendRequest<{ sceneDir: string }[]>("choicescript/projects"),
      (items) => items.length === 1,
    );
    assert.equal(projects[0].sceneDir, path.join(dir, "scenes"));
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
