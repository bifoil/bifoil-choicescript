import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startServer, waitFor } from "./helpers.js";

test(
  "opening and closing unchanged scenes retains coverage; edits and discarded buffers invalidate it",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil coverage Ω "));
    const text = "*title Coverage\n*author Test\nA paragraph.\n*ending\n";
    await mkdir(path.join(root, "scenes"));

    const uri = pathToFileURL(path.join(root, "scenes/startup.txt")).href;
    await writeFile(path.join(root, "scenes/startup.txt"), text);

    const h = await startServer([root]);

    try {
      const [project] = await waitFor(
        () => h.rpc.sendRequest<any[]>("choicescript/projects"),
        (projects) => projects.length === 1,
      );

      const run = async () => {
        const job: any = await h.rpc.sendRequest("choicescript/job", {
          protocolVersion: 1,
          operation: "randomtest",
          projectId: project.id,
          iterations: 1,
          seed: 2_147_483_648,
          trusted: true,
        });
        const completed = await waitFor(() =>
          h.events.find((event) => event.jobId === job.jobId && event.kind === "completed"),
        );

        assert.equal(completed.exitCode, 0);
        assert(h.events.some((event) => event.jobId === job.jobId && event.kind === "coverage"));

        return job.jobId;
      };

      const original = await run();
      h.open(uri, text);
      await waitFor(() => h.diagnostics.find((entry) => entry.uri === uri && entry.version === 1));

      assert(!h.events.some((event) => event.jobId === original && event.kind === "stale"));

      const beforeClose = h.diagnostics.length;
      await h.rpc.sendNotification("textDocument/didClose", { textDocument: { uri } });
      await waitFor(() => h.diagnostics.slice(beforeClose).find((entry) => entry.uri === uri));

      assert(!h.events.some((event) => event.jobId === original && event.kind === "stale"));

      h.open(uri, text);
      h.change(uri, text.replace("A paragraph.", "An unsaved paragraph."), 2);
      await waitFor(() => h.events.find((event) => event.jobId === original && event.kind === "stale"));

      const unsaved = await run();

      assert(!h.events.some((event) => event.jobId === unsaved && event.kind === "stale"));

      await h.rpc.sendNotification("textDocument/didClose", { textDocument: { uri } });
      await waitFor(() => h.events.find((event) => event.jobId === unsaved && event.kind === "stale"));
    } finally {
      await h.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
