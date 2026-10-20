import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { startServer, waitFor } from "./helpers.js";

test("reference LSP navigation and protocol failures preserve the same symbol ranges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil feature contracts Ω "));
  const source =
    "*create score 7\n*label entry\n*if score > 0\n    *print score\n*goto entry\nOriginal narrative words.\n*ending";
  await mkdir(path.join(root, "scenes"));
  const uri = pathToFileURL(path.join(root, "scenes/startup.txt")).href;
  await writeFile(path.join(root, "scenes/startup.txt"), source);
  const client = await startServer([root]);
  const params = { textDocument: { uri }, position: { line: 3, character: 12 } };
  try {
    client.open(uri, source);
    await waitFor(() => client.diagnostics.find((event) => event.uri === uri));
    const prepared: any = await client.rpc.sendRequest("textDocument/prepareRename", params);
    assert.deepEqual(prepared, { start: { line: 3, character: 11 }, end: { line: 3, character: 16 } });
    const symbols: any = await client.rpc.sendRequest("textDocument/documentSymbol", params);
    assert(symbols.some((symbol: any) => symbol.name === "entry"));
    assert(symbols.some((symbol: any) => symbol.name === "score"));
    const folds: any = await client.rpc.sendRequest("textDocument/foldingRange", params);
    assert(folds.some((fold: any) => fold.startLine === 2 && fold.endLine === 3));
    const selections: any = await client.rpc.sendRequest("textDocument/selectionRange", {
      ...params,
      positions: [params.position, { line: 5, character: 4 }],
    });
    assert.equal(selections.length, 2);
    assert.deepEqual(selections[0].range, prepared);
    await assert.rejects(
      client.rpc.sendRequest("textDocument/rename", { ...params, newName: "invalid-name" }),
      /Names must start/,
    );
    for (const request of [
      { protocolVersion: 2, operation: "run", trusted: true },
      { protocolVersion: 1, operation: "run", trusted: false },
      { protocolVersion: 1, operation: "createProject", trusted: true },
    ])
      await assert.rejects(client.rpc.sendRequest("choicescript/job", request));
    const destination = path.join(root, "created");
    await client.rpc.sendRequest("choicescript/job", {
      protocolVersion: 1,
      operation: "createProject",
      trusted: true,
      destination,
    });
    const games: any = await waitFor(
      () => client.rpc.sendRequest("choicescript/projects"),
      (value: any) => value.length === 2,
    );
    assert(games.some((game: any) => game.root === destination));
    await client.rpc.sendNotification("choicescript/assetChanged", {
      uri: pathToFileURL(path.join(root, "original.png")).href,
    });
    await client.rpc.sendRequest("choicescript/job", { protocolVersion: 1, operation: "stop", trusted: false });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace folder replacement retires old projects and discovers the new game", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil workspace replacement "));
  for (const name of ["old", "new"]) {
    await mkdir(path.join(root, name, "scenes"), { recursive: true });
    await writeFile(path.join(root, name, "scenes/startup.txt"), "Original game.\n*ending");
  }
  const client = await startServer([path.join(root, "old")]);
  try {
    const descriptor = (name: string) => ({ uri: pathToFileURL(path.join(root, name)).href, name });
    await client.rpc.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: { removed: [descriptor("old")], added: [descriptor("new")] },
    });
    const games: any = await waitFor(
      () => client.rpc.sendRequest("choicescript/projects"),
      (value: any) => value.length === 1 && value[0].root === path.join(root, "new"),
    );
    assert.equal(games[0].name, "new");
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
