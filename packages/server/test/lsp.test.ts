import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-languageserver/node.js";

test("real LSP process publishes semantic tokens and replacement-buffer diagnostics", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "choice-lsp-"));
  const server = spawn(process.execPath, ["dist/server/server.cjs", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  server.stderr.on("data", (b) => (errors += b));

  const rpc = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin));
  let diagnostics: any[] = [];
  rpc.onRequest("client/registerCapability", () => null);
  rpc.onRequest("workspace/semanticTokens/refresh", () => null);
  rpc.onNotification("textDocument/publishDiagnostics", (p) => diagnostics.push(p));
  rpc.listen();

  try {
    await mkdir(path.join(dir, "scenes"));

    const file = path.join(dir, "scenes/startup.txt"),
      uri = pathToFileURL(file).href;
    await writeFile(file, '*create name "Alex"\n*print name');

    const initialized: any = await Promise.race([
      rpc.sendRequest("initialize", {
        processId: process.pid,
        capabilities: {
          workspace: { semanticTokens: { refreshSupport: true } },
        },
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: "game" }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Initialize timeout: " + errors)), 5000).unref()),
    ]);

    assert(initialized.capabilities.semanticTokensProvider);

    await rpc.sendNotification("initialized", {});
    await rpc.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "choicescript",
        version: 1,
        text: '*create name "Alex"\n*print name',
      },
    });
    for (let i = 0; i < 100 && !diagnostics.length; i++) await new Promise((r) => setTimeout(r, 50));

    assert(diagnostics.length, errors);

    const tokens: any = await rpc.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });

    assert(tokens.data.length);

    await rpc.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: '*create name "broken\n*print 42' }],
    });
    for (let i = 0; i < 100 && !diagnostics.some((d) => d.version === 2); i++)
      await new Promise((r) => setTimeout(r, 50));

    assert(diagnostics.some((d) => d.version === 2 && d.diagnostics.some((x: any) => x.code === "expression-string")));

    await rpc.sendRequest("shutdown");
    await rpc.sendNotification("exit");
  } finally {
    rpc.dispose();
    server.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
