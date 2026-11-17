import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

// An unopened, undiscovered URI must not manufacture analysis or launch a tool.
test("unavailable LSP documents return the protocol's empty results", { timeout: 20000 }, async () => {
  const server = await startServer([], { legacyRootUri: true });
  const parameters = {
    textDocument: { uri: "untitled:original-boundary" },
    position: { line: 0, character: 0 },
    positions: [{ line: 0, character: 0 }],
    context: { includeDeclaration: true },
    newName: "renamed",
  };
  try {
    for (const [method, expected] of [
      ["textDocument/completion", []],
      ["textDocument/hover", null],
      ["textDocument/definition", null],
      ["textDocument/references", []],
      ["textDocument/prepareRename", null],
      ["textDocument/rename", null],
      ["textDocument/documentSymbol", []],
      ["textDocument/foldingRange", []],
      ["textDocument/selectionRange", []],
      ["textDocument/semanticTokens/full", { data: [] }],
    ] as const)
      assert.deepEqual(await server.rpc.sendRequest(method, parameters), expected, method);
    assert.equal(await server.rpc.sendRequest("choicescript/wordCount", { uri: parameters.textDocument.uri }), 0);
    assert.deepEqual(await server.rpc.sendRequest("workspace/symbol", { query: "original" }), []);
    assert.deepEqual(await server.rpc.sendRequest("choicescript/projects"), []);
    assert.deepEqual(await server.rpc.sendRequest("choicescript/indexStatus"), []);
    await server.rpc.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: "untitled:original-boundary", type: 2 }],
    });
    await server.rpc.sendNotification("workspace/didChangeConfiguration", {});
    assert.equal(server.child.exitCode, null);
  } finally {
    await server.close();
  }
});

test("custom job requests reject invalid protocol trust and missing destinations before launch", { timeout: 20000 }, async () => {
  const server = await startServer([]);
  try {
    for (const [request, message] of [
      [null, /protocolVersion/],
      [{ protocolVersion: 2 }, /protocolVersion/],
      [{ protocolVersion: 1, operation: "quicktest" }, /Trust the workspace/],
      [{ protocolVersion: 1, operation: "createProject", trusted: true }, /Choose a destination/],
      [{ protocolVersion: 1, operation: "quicktest", trusted: true, projectId: "missing" }, /Select a detected/],
    ] as const)
      await assert.rejects(server.rpc.sendRequest("choicescript/job", request), message);
    await assert.rejects(server.rpc.sendRequest("workspace/executeCommand", { command: "bifoil.quicktest" }), /protocolVersion/);
    const stopped: any = await server.rpc.sendRequest("choicescript/job", { protocolVersion: 1, operation: "stop", trusted: false });
    assert(stopped);
    assert.equal(server.events.length, 0);
  } finally {
    await server.close();
  }
});
