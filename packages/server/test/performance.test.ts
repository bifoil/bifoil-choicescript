import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { interactionDeadlineMs, interactionTargetMs } from "@bifoil/choicescript-protocol";
import { CancellationTokenSource } from "vscode-languageserver/node.js";
import { classification, startServer, waitFor } from "./helpers.js";

test("current editor interactions finish within one second across six large games", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bifoil latency Ω "));
  const text =
    '*create gender "male"\r\n*create implicit_control_flow true\r\n' +
    'She said "This is the end,\r\n*if gender = "male"\r\n    William."\r\n*else\r\n    Belle."\r\nShe walked away.\r\n'.repeat(
      3334,
    ) +
    "*ending\r\n";
  const uris: string[] = [];
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  const timed = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const result = await action().catch((cause: unknown) => {
      throw new Error(name + " failed after " + Math.round(performance.now() - start) + " ms", { cause });
    });

    const elapsed = performance.now() - start;
    assert(
      elapsed < interactionDeadlineMs,
      `${name} exceeded one second (${Math.round(elapsed)} ms). ${server?.stderr ?? ""}`,
    );

    return result;
  };

  try {
    for (let i = 0; i < 6; i++) {
      const scenes = path.join(dir, "game " + i, "scenes");
      await mkdir(scenes, { recursive: true });

      const file = path.join(scenes, "startup.txt");
      await writeFile(file, text);
      uris.push(pathToFileURL(file).href);
    }

    const h = (server = await startServer([dir]));
    const uri = uris[5],
      line = text.split("\r\n").findLastIndex((l) => l.startsWith("*if"));
    const p = { textDocument: { uri }, position: { line, character: 5 } };
    await timed("opening the active game", async () => {
      h.open(uri, text);
      await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === 1));
    });
    // Background discovery/analysis can continue without delaying active-document feedback.
    await waitFor(() => uris.every((source) => h.diagnostics.some((d) => d.uri === source)));

    for (const source of uris) {
      const params = { ...p, textDocument: { uri: source } };
      const value: any = await timed("hover", () => h.rpc.sendRequest("textDocument/hover", params));

      assert(value.contents.value.includes("gender"));

      const completion: any = await timed("completion", () => h.rpc.sendRequest("textDocument/completion", params));

      assert(completion.some((c: any) => c.label === "gender"));

      const definition: any = await timed("definition", () => h.rpc.sendRequest("textDocument/definition", params));

      assert.equal(definition.uri, source);

      const refs: any = await timed("references", () =>
        h.rpc.sendRequest("textDocument/references", { ...params, context: { includeDeclaration: true } }),
      );

      assert(refs.length > 3000);

      const edit: any = await timed("rename", () =>
        h.rpc.sendRequest("textDocument/rename", { ...params, newName: "actor_gender" }),
      );

      assert(edit.changes[source].length > 3000);

      const tokens: any = await timed("highlighting", () =>
        h.rpc.sendRequest("textDocument/semanticTokens/full", { textDocument: params.textDocument }),
      );

      assert.equal(classification(tokens, h.legend, 4, 4), "dialogue");
    }

    for (let version = 2; version <= 4; version++) {
      const type = version % 2 ? "number" : "boolean";
      const changed = text.replace('*create gender "male"', "*create gender " + (type === "number" ? "7" : "true"));
      const start = performance.now();
      h.change(uri, changed, version);

      const [value, unaffected]: any[] = await Promise.all([
        timed("hover immediately after typing", () => h.rpc.sendRequest("textDocument/hover", p)),
        timed("unaffected game hover", () =>
          h.rpc.sendRequest("textDocument/hover", { ...p, textDocument: { uri: uris[0] } }),
        ),
      ]);

      assert(value.contents.value.includes("Type: " + String.fromCharCode(96) + type));
      assert(unaffected.contents.value.includes("Type: " + String.fromCharCode(96) + "string"));

      await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === version));
      await waitFor(() => h.refreshes.some((time) => time >= start));

      assert(
        performance.now() - start < interactionDeadlineMs,
        "Typing-to-current-diagnostics and highlighting exceeded one second",
      );

      const tokens: any = await timed("updated highlighting", () =>
        h.rpc.sendRequest("textDocument/semanticTokens/full", { textDocument: p.textDocument }),
      );

      assert.equal(classification(tokens, h.legend, line, 5), type + "Variable");
    }

    h.change(uri, text, 5);
    await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === 5));

    const words: number = await h.rpc.sendRequest("choicescript/wordCount", { uri });

    for (let version = 6; version <= 8; version++) {
      const changed = text.replace("She walked away.", "She walked away. " + "again".repeat(version - 5));
      const start = performance.now();
      h.change(uri, changed, version);

      const hover: any = await h.rpc.sendRequest("textDocument/hover", p);

      assert(hover.contents.value.includes("gender"));

      await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === version));

      const count: number = await h.rpc.sendRequest("choicescript/wordCount", { uri });

      assert.equal(count, words + 1);
      assert(performance.now() - start < interactionTargetMs, "Ordinary typing exceeded the ideal half-second target");
    }

    h.change(uri, text.replace('*create gender "male"', "*create gender 7"), 9);

    const cancellation = new CancellationTokenSource();
    const pending = h.rpc.sendRequest("textDocument/hover", p, cancellation.token);
    cancellation.cancel();
    await assert.rejects(pending, (e: any) => e.code === -32800);
    cancellation.dispose();
    await waitFor(() => h.diagnostics.find((d) => d.uri === uri && d.version === 9));
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
