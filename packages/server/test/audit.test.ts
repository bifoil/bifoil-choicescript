import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startServer, waitFor } from "./helpers.js";

test(
  "LSP clears stale test failures, honors references context and stops missing projects",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil server audit "));
    await mkdir(path.join(root, "scenes"));

    const file = path.join(root, "scenes/startup.txt"),
      uri = pathToFileURL(file).href;
    const bad = "*title Audit\n*author Test\n*create score 1\n*print missing_variable\n*print score\n*ending";
    const good = bad.replace("missing_variable", "score");
    await writeFile(file, bad);

    const h = await startServer([root]);

    try {
      const [project] = await waitFor(
        () => h.rpc.sendRequest<any[]>("choicescript/projects"),
        (projects) => projects.length === 1,
      );
      h.open(uri, bad);
      await waitFor(() => h.diagnostics.findLast((entry) => entry.uri === uri && entry.version === 1));

      const command = async (operation: string, jobId?: string) =>
        h.rpc.sendRequest<any>("choicescript/job", {
          protocolVersion: 1,
          operation,
          projectId: project.id,
          trusted: true,
          jobId,
        });

      const failed = await command("quicktest");
      await waitFor(() => h.events.find((event) => event.jobId === failed.jobId && event.kind === "completed"));
      await waitFor(() =>
        h.diagnostics
          .findLast((entry) => entry.uri === uri)
          ?.diagnostics.some((d: any) => d.source === "ChoiceScript test"),
      );
      h.change(uri, good, 2);
      await waitFor(
        () => h.diagnostics.findLast((entry) => entry.uri === uri && entry.version === 2),
        (entry) => !!entry && !entry.diagnostics.some((d: any) => d.source === "ChoiceScript test"),
      );

      const refs: any[] = await waitFor(
        () =>
          h.rpc.sendRequest<any[]>("textDocument/references", {
            textDocument: { uri },
            position: { line: 2, character: 10 },
            context: { includeDeclaration: false },
          }),
        (refs) => refs.length === 2,
      );

      assert.equal(refs.length, 2);
      assert(refs.every((ref) => ref.range.start.line !== 2));

      const passed = await command("quicktest");

      assert.equal(
        (await waitFor(() => h.events.find((event) => event.jobId === passed.jobId && event.kind === "completed")))
          .exitCode,
        0,
      );

      const preview = await command("run");
      await rm(path.join(root, "scenes"), { recursive: true, force: true });
      await command("stop", preview.jobId);
      await assert.rejects(fetch(preview.url));
      await waitFor(() => h.events.find((event) => event.jobId === preview.jobId && event.kind === "completed"));
      // Cancellation sent alongside the start also works before any job response.
      await mkdir(path.join(root, "scenes"));
      await writeFile(file, good);
      await h.rpc.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 1 }] });
      await waitFor(
        () => h.rpc.sendRequest<any[]>("choicescript/projects"),
        (projects) => projects.length === 1,
      );

      const id = randomUUID();
      const starting = command("quicktest", id);
      const rejected = assert.rejects(
        starting,
        (error: any) => error.code === -32800 && /cancelled/i.test(error.message),
      );
      await command("stop", id);
      await rejected;
    } finally {
      await h.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("successful official tests retain warnings until the source changes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil warnings "));
  await mkdir(path.join(root, "scenes"));

  const file = path.join(root, "scenes/startup.txt"),
    uri = pathToFileURL(file).href;
  const text = "*title Audit\n*author Test\n*create score 1\n*temp score 2\n*print score\n*ending";
  await writeFile(file, text);

  const h = await startServer([root]);

  try {
    const [project] = await waitFor(
      () => h.rpc.sendRequest<any[]>("choicescript/projects"),
      (projects) => projects.length === 1,
    );
    h.open(uri, text);
    await waitFor(() => h.diagnostics.findLast((entry) => entry.uri === uri && entry.version === 1));

    const result = await h.rpc.sendRequest<any>("choicescript/job", {
      protocolVersion: 1,
      operation: "quicktest",
      trusted: true,
      projectId: project.id,
    });
    const completed = await waitFor(() =>
      h.events.find((event) => event.jobId === result.jobId && event.kind === "completed"),
    );

    assert.equal(completed.exitCode, 0);

    await waitFor(() =>
      h.diagnostics
        .findLast((entry) => entry.uri === uri)
        ?.diagnostics.some((d: any) => d.source === "ChoiceScript test" && d.severity === 2),
    );
    h.change(uri, text.replace("*temp score 2\n", ""), 2);
    await waitFor(
      () => h.diagnostics.findLast((entry) => entry.uri === uri && entry.version === 2),
      (entry) => !!entry && !entry.diagnostics.some((d: any) => d.source === "ChoiceScript test"),
    );
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "analysis dispatches every game in a workspace with more games than worker slots",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil analysis pool "));
    const files: string[] = [];

    for (let i = 0; i < 9; i++) {
      const dir = path.join(root, "game" + i, "scenes");
      await mkdir(dir, { recursive: true });

      const file = path.join(dir, "startup.txt");
      await writeFile(file, "*create score 1\n*print score\n*ending");
      files.push(pathToFileURL(file).href);
    }

    const h = await startServer([root]);

    try {
      await waitFor(
        () => h.rpc.sendRequest<any[]>("choicescript/projects"),
        (projects) => projects.length === 9,
      );
      for (const uri of files) await waitFor(() => h.diagnostics.findLast((entry) => entry.uri === uri));

      for (const uri of files) {
        const tokens = await h.rpc.sendRequest<any>("textDocument/semanticTokens/full", { textDocument: { uri } });

        assert(tokens.data.length > 0);
      }
    } finally {
      await h.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("owned log notifications keep current language analysis available", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil ignored watcher "));
  await mkdir(path.join(root, "scenes"));
  await writeFile(path.join(root, "scenes/startup.txt"), "*create score 1\n*print score\n*ending");

  const h = await startServer([root]);

  try {
    const symbols = () => h.rpc.sendRequest<any[]>("workspace/symbol", { query: "score" });

    await waitFor(symbols, (entries) => entries.length === 1);
    await h.rpc.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(path.join(root, ".bifoil-choicescript/logs/job.log")).href, type: 2 }],
    });

    assert.equal((await symbols()).length, 1);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});
