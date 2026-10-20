import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classification, startServer, waitFor } from "./helpers.js";

test(
  "project resource exhaustion preserves current-scene editing and refuses unsafe refactoring",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil recovery Ω "));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      const text = "*create shared 0\n*print shared\n*goto_scene scene0";
      const uri = pathToFileURL(path.join(root, "startup.txt")).href;
      await writeFile(path.join(root, "startup.txt"), text);
      // Small on disk, deliberately large as a whole-project command graph. The
      // bounded worker must either hit its memory or transfer-work limit.
      for (let i = 0; i < 60; i++)
        await writeFile(
          path.join(root, `scene${i}.txt`),
          "*set shared +1\n".repeat(2000) + (i < 59 ? `*goto_scene scene${i + 1}` : "*ending"),
        );

      const h = (server = await startServer([root]));
      const warnings: any[] = [];
      h.rpc.onNotification("window/showMessage", (p) => warnings.push(p));
      h.open(uri, text);
      await waitFor(
        () => h.rpc.sendRequest<any[]>("choicescript/indexStatus"),
        (xs) => xs.some((x) => x.limited),
        35000,
      );

      const params = { textDocument: { uri }, position: { line: 1, character: 8 } };
      const tokens: any = await h.rpc.sendRequest("textDocument/semanticTokens/full", params);
      assert.equal(classification(tokens, h.legend, 1, 8), "numberVariable");
      const hover: any = await h.rpc.sendRequest("textDocument/hover", params);
      assert(hover.contents.value.includes("shared"));
      assert.equal(warnings.filter((p) => p.type === 2).length, 1);
      assert.equal(h.child.exitCode, null);

      h.change(uri, text.replace("shared 0", "shared false"), 2);
      await waitFor(() => h.diagnostics.find((p) => p.uri === uri && p.version === 2));
      const updated: any = await h.rpc.sendRequest("textDocument/semanticTokens/full", params);
      assert.equal(classification(updated, h.legend, 1, 8), "booleanVariable");
      await assert.rejects(
        h.rpc.sendRequest("textDocument/rename", { ...params, newName: "renamed" }),
        (error: any) => error.code === -32801 && /work limit/.test(error.message),
      );
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
