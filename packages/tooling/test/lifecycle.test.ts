import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ToolRunner, discoverProjects } from "../src/index.js";
import type { JobEvent, JobRequest } from "../../protocol/src/index.js";
import { waitFor } from "../../server/test/helpers.js";
const engine = fileURLToPath(
  new URL("../../../vendor/choicescript", import.meta.url),
);
test(
  "tool jobs serialize preview restarts and clean pending starts, failures and cancelled workers",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "branchlight lifecycle Ω "),
    );
    const events: JobEvent[] = [];
    const runner = new ToolRunner(engine, (e) => events.push(e));
    await mkdir(path.join(root, "scenes"));
    const file = path.join(root, "scenes/startup.txt");
    await writeFile(
      file,
      "*title Lifecycle\n*author Test\nDisk snapshot.\n*ending",
    );
    const [project] = await discoverProjects([root]);
    const start = (
      operation: JobRequest["operation"],
      options: Partial<JobRequest> = {},
      text?: string,
    ) =>
      runner.start(
        { protocolVersion: 1, operation, trusted: true, ...options },
        project,
        text === undefined
          ? []
          : [{ uri: pathToFileURL(file).href, version: 2, text }],
      );
    const done = (id: string) =>
      waitFor(() =>
        events.find((e) => e.jobId === id && e.kind === "completed"),
      );
    try {
      const [first, second] = await Promise.all([
        start("run"),
        start("run", {}, "Unsaved snapshot.\n*ending"),
      ]);
      assert.equal((await done(first.jobId))!.exitCode, 130);
      await assert.rejects(fetch(first.url!));
      assert(
        (
          await (await fetch(new URL("scenes/startup.txt", second.url))).text()
        ).includes("Unsaved snapshot."),
      );
      const stage = runner.jobs.get(second.jobId)!.stage;
      await Promise.all([runner.stop(second.jobId), runner.stop(second.jobId)]);
      assert.equal(
        events.filter((e) => e.jobId === second.jobId && e.kind === "completed")
          .length,
        1,
      );
      await assert.rejects(access(stage));
      const worker = await start("randomtest", { iterations: 10000000 });
      const process = runner.jobs.get(worker.jobId)!.child!;
      const workerStage = runner.jobs.get(worker.jobId)!.stage;
      await runner.stop(worker.jobId);
      assert.equal((await done(worker.jobId))!.exitCode, 130);
      assert(process.exitCode !== null || process.signalCode !== null);
      await assert.rejects(access(workerStage));
      const invalid = await start(
        "quicktest",
        {},
        "*title Bad\n*author Test\n*print missing_variable\n*ending",
      );
      assert.equal((await done(invalid.jobId))!.exitCode, 1);
      assert(
        events.some(
          (e) =>
            e.jobId === invalid.jobId &&
            e.kind === "diagnostic" &&
            e.uri === pathToFileURL(file).href &&
            e.line === 2,
        ),
      );
      assert(
        (await readFile(invalid.output!, "utf8")).includes("missing_variable"),
      );
      const destination = path.join(root, "export/game.html");
      await mkdir(path.dirname(destination));
      await writeFile(destination, "preserve this file");
      const collision = await start("exportHtml", { destination });
      assert.equal((await done(collision.jobId))!.exitCode, 1);
      assert.equal(await readFile(destination, "utf8"), "preserve this file");
      const recovered = await start("quicktest");
      assert.equal((await done(recovered.jobId))!.exitCode, 0);
      runner.markStale(project.id);
      assert(
        events.some(
          (e) => e.jobId === recovered.jobId && e.kind === "stale" && e.stale,
        ),
      );
      const pending = start("run");
      runner.markStale(project.id);
      const disposed = runner.dispose();
      const preview = await pending;
      await disposed;
      assert.equal(runner.jobs.size, 0);
      assert(
        events.some(
          (e) => e.jobId === preview.jobId && e.kind === "started" && e.stale,
        ),
      );
      await assert.rejects(fetch(preview.url!));
      await assert.rejects(start("run"), /shutting down/);
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
