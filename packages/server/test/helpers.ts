import { spawn } from "node:child_process";
import { once } from "node:events";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-languageserver/node.js";
import { serverNodeArgs } from "@bifoil/choicescript-protocol";
import { pathToFileURL } from "node:url";

export async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean = (v) => !!v,
  timeout = 15000,
): Promise<T> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const value = await read();

    if (accept(value)) return value;

    await new Promise((r) => setTimeout(r, 30));
  }

  throw new Error("Timed out waiting for observable LSP state");
}

export async function startServer(roots: string[], options: { legacyRootUri?: boolean } = {}) {
  const child = spawn(process.execPath, [...serverNodeArgs, "dist/server/server.cjs", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const diagnostics: any[] = [];
  const events: any[] = [];
  const refreshes: number[] = [];
  let errors = "";
  child.stderr.on("data", (b) => (errors += b));

  const rpc = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  rpc.onRequest("client/registerCapability", () => null);
  rpc.onRequest("workspace/semanticTokens/refresh", () => {
    refreshes.push(performance.now());
    return null;
  });
  rpc.onNotification("textDocument/publishDiagnostics", (p) => diagnostics.push(p));
  rpc.onNotification("choicescript/jobEvent", (p) => events.push(p));
  rpc.listen();

  const initialized: any = await rpc.sendRequest("initialize", {
    processId: process.pid,
    capabilities: { workspace: { semanticTokens: { refreshSupport: true } } },
    ...(options.legacyRootUri
      ? { rootUri: roots.length ? pathToFileURL(roots[0]).href : null }
      : { workspaceFolders: roots.map((root) => ({ uri: pathToFileURL(root).href, name: root })) }),
  });
  await rpc.sendNotification("initialized", {});

  return {
    rpc,
    child,
    diagnostics,
    events,
    refreshes,
    legend: initialized.capabilities.semanticTokensProvider.legend,
    open(uri: string, text: string, version = 1) {
      rpc.sendNotification("textDocument/didOpen", {
        textDocument: { uri, text, version, languageId: "choicescript" },
      });
    },
    change(uri: string, text: string, version: number) {
      rpc.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    },
    async close() {
      try {
        await rpc.sendRequest("shutdown");
        await rpc.sendNotification("exit");

        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        timer.unref();
        if (child.exitCode === null) await once(child, "exit");

        clearTimeout(timer);
      } finally {
        rpc.dispose();
        if (child.exitCode === null) child.kill();
      }

      if (child.exitCode) throw new Error(errors || `Server exited ${child.exitCode}`);
    },
  };
}

export function classification(tokens: any, legend: any, line: number, column: number) {
  let row = 0,
    col = 0;

  for (let i = 0; i < tokens.data.length; i += 5) {
    col = tokens.data[i] === 0 ? col + tokens.data[i + 1] : tokens.data[i + 1];
    row += tokens.data[i];
    if (row === line && col <= column && col + tokens.data[i + 2] > column)
      return legend.tokenTypes[tokens.data[i + 3]];
  }
}
