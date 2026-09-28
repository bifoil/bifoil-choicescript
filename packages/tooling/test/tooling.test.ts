import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverProjects, projectFor, readProject, ToolRunner } from "@branchlight/tooling";
import type { JobEvent } from "@branchlight/protocol";

const engine = fileURLToPath(new URL("../../../vendor/choicescript", import.meta.url));
test("discovery associates only scene directories and preserves other text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "choice paths Ω "));
  try {
    await mkdir(path.join(root, "game/scenes"), { recursive: true });
    await writeFile(path.join(root, "game/scenes/startup.txt"), "Hello");
    await writeFile(path.join(root, "notes.txt"), "notes");
    const projects = await discoverProjects([root]);
    assert.equal(projects.length, 1);
    assert(projectFor(projects, pathToFileURL(path.join(root, "game/scenes/startup.txt")).href));
    assert(!projectFor(projects, pathToFileURL(path.join(root, "notes.txt")).href));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("official template, QuickTest, RandomTest, snapshot preview, export, cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "choice integration Ω "));
  let runner: ToolRunner | undefined;
  try {
    const events: JobEvent[] = [];
    runner = new ToolRunner(engine, (e) => events.push(e));
    const game = path.join(root, "my game");
    await runner.createProject(game);
    await assert.rejects(() => runner!.createProject(game), /empty directory/);
    const fixture =
      '*title Test Game\n*author Test\n*create gender "male"\n*create implicit_control_flow true\nShe said "This is the end,\n*if gender = "male"\n  William."\n*else\n  Belle."\n*ending\n';
    await writeFile(path.join(game, "scenes/startup.txt"), fixture);
    await writeFile(path.join(game, "scenes/choicescript_stats.txt"), "No stats.\n");
    const projects = await discoverProjects([game]),
      project = projects[0];
    assert(project);
    async function completed(id: string) {
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const done = events.find((e) => e.jobId === id && e.kind === "completed");
        if (done) return done;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(
        "job timed out: " +
          events
            .filter((e) => e.jobId === id)
            .map((e) => e.message)
            .join("\n"),
      );
    }
    await assert.rejects(
      () => runner!.start({ protocolVersion: 1, operation: "quicktest", trusted: false }, project, []),
      /Trust/,
    );
    for (const operation of ["quicktest", "randomtest"] as const) {
      const job = await runner.start(
        {
          protocolVersion: 1,
          operation,
          trusted: true,
          iterations: 5,
          seed: 12,
        },
        project,
        [],
      );
      const done = await completed(job.jobId);
      assert.equal(
        done.exitCode,
        0,
        events
          .filter((e) => e.jobId === job.jobId)
          .map((e) => e.message)
          .join("\n"),
      );
      assert(
        (await readFile(job.output!, "utf8")).includes(
          operation === "randomtest" ? "RANDOMTEST PASSED" : "QUICKTEST PASSED",
        ),
      );
    }
    const coverageRuns: unknown[] = [];
    for (const gender of ["male", "female"]) {
      const buffers = [
        {
          uri: pathToFileURL(path.join(project.sceneDir, "startup.txt")).href,
          text: fixture.replace('gender "male"', 'gender "' + gender + '"'),
          version: 2,
        },
      ];
      const job = await runner.start(
        {
          protocolVersion: 1,
          operation: "randomtest",
          trusted: true,
          iterations: 1,
          seed: 42,
          showText: true,
        },
        project,
        buffers,
      );
      assert.equal((await completed(job.jobId)).exitCode, 0);
      const log = await readFile(job.output!, "utf8");
      assert(log.includes(gender === "male" ? "William." : "Belle."), log);
    }
    for (let i = 0; i < 2; i++) {
      const job = await runner.start(
        {
          protocolVersion: 1,
          operation: "randomtest",
          trusted: true,
          iterations: 3,
          seed: 99,
        },
        project,
        [],
      );
      assert.equal((await completed(job.jobId)).exitCode, 0);
      coverageRuns.push(events.find((e) => e.jobId === job.jobId && e.kind === "coverage")?.coverage);
    }
    assert(coverageRuns[0]);
    assert.deepEqual(coverageRuns[0], coverageRuns[1]);
    const preview = await runner.start({ protocolVersion: 1, operation: "run", trusted: true }, project, [
      {
        uri: pathToFileURL(path.join(project.sceneDir, "startup.txt")).href,
        text: fixture.replace("William", "Snapshot William"),
        version: 1,
      },
    ]);
    const stage = runner.jobs.get(preview.jobId)!.stage;
    await assert.rejects(readFile(path.join(stage, ".git")), { code: "ENOENT" });
    assert(preview.url);
    assert.equal((await fetch(preview.url!)).status, 200);
    const scene = new URL("scenes/startup.txt", preview.url);
    assert((await (await fetch(scene)).text()).includes("Snapshot William"));
    runner.markStale(project.id);
    assert(events.some((e) => e.kind === "stale"));
    await runner.stop(preview.jobId);
    assert.equal(runner.jobs.size, 0);
    const dest = path.join(root, "export/game.html"),
      exportJob = await runner.start(
        {
          protocolVersion: 1,
          operation: "exportHtml",
          trusted: true,
          destination: dest,
        },
        project,
        [],
      );
    const done = await completed(exportJob.jobId);
    assert.equal(
      done.exitCode,
      0,
      events
        .filter((e) => e.jobId === exportJob.jobId)
        .map((e) => e.message)
        .join("\n"),
    );
    assert((await readFile(dest, "utf8")).includes("Test Game"));
    const cancelled = await runner.start(
      {
        protocolVersion: 1,
        operation: "randomtest",
        trusted: true,
        iterations: 10000000,
      },
      project,
      [],
    );
    await runner.stop(cancelled.jobId);
    assert.equal((await completed(cancelled.jobId)).exitCode, 130);
  } finally {
    await runner?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("project snapshots deduplicate equivalent encoded file URIs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "branchlight URI Ω "));
  try {
    await mkdir(path.join(root, "scenes"));
    const file = path.join(root, "scenes/startup.txt");
    await writeFile(file, "Disk");
    const [project] = await discoverProjects([root]);
    const original = pathToFileURL(file).href;
    const uri =
      process.platform === "win32"
        ? original.replace(/file:\/\/\/([A-Za-z]):/, (_, drive) => `file:///${drive.toLowerCase()}%3A`)
        : original.replace("startup", "%73tartup");
    const files = await readProject(project, [{ uri, version: 9, text: "Unsaved" }]);
    assert.equal(files.length, 1);
    assert.equal(files[0].text, "Unsaved");
    assert.equal(files[0].uri, uri);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
