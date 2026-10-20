import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classification, startServer, waitFor } from "./helpers.js";

test("worker reuse keeps project symbols, types, and source versions isolated", { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil projects Ω "));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const games: { variable: string; text: string; uri: string; helper: string; version: number }[] = [];
    for (const [name, value] of [
      ["one", "1"],
      ["two", '"text"'],
    ]) {
      const directory = path.join(root, name);
      await mkdir(directory);
      const variable = "only_" + name;
      const text = `*create ${variable} ${value}\n*goto_scene helper`;
      await writeFile(path.join(directory, "startup.txt"), text);
      await writeFile(path.join(directory, "helper.txt"), `*print ${variable}\n*ending`);
      games.push({
        variable,
        text,
        uri: pathToFileURL(path.join(directory, "startup.txt")).href,
        helper: pathToFileURL(path.join(directory, "helper.txt")).href,
        version: 1,
      });
    }
    const h = (server = await startServer([root]));
    for (const game of games) h.open(game.uri, game.text);
    await waitFor(
      () => h.rpc.sendRequest<any[]>("choicescript/indexStatus"),
      (xs) => xs.length === 2 && xs.every((x) => x.complete),
    );
    for (const [index, value, type] of [
      [0, "true", "boolean"],
      [1, "7", "number"],
      [0, '"changed"', "string"],
      [1, "false", "boolean"],
    ] as const) {
      const game = games[index];
      game.version++;
      h.change(game.uri, `*create ${game.variable} ${value}\n*goto_scene helper`, game.version);
      await waitFor(() => h.diagnostics.find((d) => d.uri === game.uri && d.version === game.version));
      const params = { textDocument: { uri: game.helper }, position: { line: 0, character: 9 } };
      const tokens: any = await h.rpc.sendRequest("textDocument/semanticTokens/full", params);
      assert.equal(classification(tokens, h.legend, 0, 9), type + "Variable");
      const target: any = await h.rpc.sendRequest("textDocument/definition", params);
      assert.equal(target.uri, game.uri);
      const items: any = await h.rpc.sendRequest("textDocument/completion", params);
      assert(items.some((item: any) => item.label === game.variable));
      assert(!items.some((item: any) => item.label === games[1 - index].variable));
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
