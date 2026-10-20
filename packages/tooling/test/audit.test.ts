import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { affectedProjects, discoverProjects, ToolRunner } from "@bifoil/choicescript-tooling";
import type { JobEvent } from "@bifoil/choicescript-protocol";
import { waitFor } from "../../server/test/helpers.js";

const engine = fileURLToPath(new URL("../../../vendor/choicescript", import.meta.url));
const request = { protocolVersion: 1 as const, operation: "quicktest" as const, trusted: true };

async function createGameFixture(root: string) {
  const fakeEngine = path.join(root, "engine");
  const game = path.join(root, "game");
  await mkdir(path.join(fakeEngine, "web/mygame/scenes"), { recursive: true });
  await mkdir(path.join(game, "scenes"), { recursive: true });
  await writeFile(path.join(game, "scenes/startup.txt"), "*ending");

  return { fakeEngine, game };
}

test("malformed configurations isolate failures from healthy neighboring games", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil discovery "));

  try {
    for (const [name, config] of [
      ["null", "null"],
      ["array", "[]"],
      ["broken", "{"],
      ["paths", '{"assets":2}'],
      ["seeds", '{"randomtest":{"seed":9007199254740991}}'],
    ]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "choicescript.json"), config);
    }

    await mkdir(path.join(root, "healthy/scenes"), { recursive: true });
    await writeFile(path.join(root, "healthy/scenes/startup.txt"), "*ending");

    const errors: string[] = [];
    const projects = await discoverProjects([root], (_, message) => errors.push(message));

    assert.equal(errors.length, 5);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, "healthy");
    assert.equal(affectedProjects(projects, pathToFileURL(path.join(root, "healthy/image.png")).href).length, 1);
    assert.equal(affectedProjects(projects, pathToFileURL(path.join(root, "other.txt")).href).length, 0);
    assert.equal(
      affectedProjects(projects, pathToFileURL(path.join(root, "healthy/.bifoil-choicescript/logs/job.log")).href)
        .length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flat scene roots survive repeated runs, coverage prose and warnings", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil flat Ω "));
  const events: JobEvent[] = [];
  const runner = new ToolRunner(engine, (event) => events.push(event));

  try {
    await writeFile(
      path.join(root, "startup.txt"),
      "*title Audit\n*author Test\nstartup line 12: just prose.\n*finish",
    );
    await mkdir(path.join(root, "backups"));

    const [project] = await discoverProjects([root]);

    for (const operation of ["quicktest", "quicktest", "randomtest"] as const) {
      const job = await runner.start({ ...request, operation, iterations: 1, showText: true }, project, []);
      const completed = await waitFor(() =>
        events.find((event) => event.jobId === job.jobId && event.kind === "completed"),
      );

      assert.equal(
        completed?.exitCode,
        0,
        events
          .filter((e) => e.jobId === job.jobId)
          .map((e) => e.message)
          .join("\n"),
      );
      assert(!events.some((event) => event.jobId === job.jobId && event.kind === "diagnostic" && event.severity !== 2));
    }
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "buffering a linked scene cannot write through staging into the source",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil links "));
    const runner = new ToolRunner(engine, () => {});
    let stage: string | undefined;

    try {
      await mkdir(path.join(root, "scenes"));

      const original = path.join(root, "original.txt");
      await writeFile(original, "Original must remain unchanged.");
      await symlink(original, path.join(root, "scenes/startup.txt"));

      const [project] = await discoverProjects([root]);
      stage = await runner.stage(project, [
        {
          uri: pathToFileURL(path.join(root, "scenes/startup.txt")).href,
          text: "*title Linked\n*author Test\nSnapshot.\n*ending",
          version: 1,
        },
      ]);

      assert.equal(await readFile(original, "utf8"), "Original must remain unchanged.");
      assert((await readFile(path.join(stage, "web/mygame/scenes/startup.txt"), "utf8")).includes("Snapshot."));
    } finally {
      await runner.dispose();
      if (stage) await rm(stage, { recursive: true, force: true });

      await rm(root, { recursive: true, force: true });
    }
  },
);

test("preparation children are cancellable without waiting behind the start queue", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil prepare "));
  const events: JobEvent[] = [];
  const { fakeEngine, game } = await createGameFixture(root);
  await writeFile(path.join(fakeEngine, "mygamegenerator.js"), "setInterval(() => {}, 1000)");

  const runner = new ToolRunner(fakeEngine, (event) => events.push(event));

  try {
    const [project] = await discoverProjects([game]);
    const id = randomUUID();
    const starting = runner.start({ ...request, jobId: id }, project, []);
    const rejected = assert.rejects(starting, /cancelled|aborted/i);
    await waitFor(() => runner.jobs.get(id)?.child);

    const child = runner.jobs.get(id)!.child!;
    const queuedId = randomUUID();
    const queued = runner.start({ ...request, jobId: queuedId }, project, []);
    const queuedRejected = assert.rejects(queued, /cancelled|aborted/i);
    await runner.start({ ...request, operation: "stop", jobId: id }, project, []);
    await runner.stop(queuedId);
    await Promise.all([rejected, queuedRejected]);

    assert(child.exitCode !== null || child.signalCode !== null);
    assert.equal(runner.jobs.size, 0);
    assert.equal(events.filter((event) => event.kind === "completed").length, 2);
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker streams preserve split UTF-8 and keep stderr out of stdout diagnostics", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil streams "));
  const { fakeEngine, game } = await createGameFixture(root);
  await writeFile(path.join(fakeEngine, "mygamegenerator.js"), 'console.log("generated")');
  await writeFile(
    path.join(fakeEngine, "quicktest.js"),
    [
      'const bytes = Buffer.from("QUICKTEST FAILED\\nβ.chapter line 2: café");',
      "process.stdout.write(bytes.subarray(0, bytes.length - 1));",
      'process.stderr.write("separate stderr\\n");',
      'setTimeout(() => { process.stdout.write(bytes.subarray(bytes.length - 1)); process.stdout.write("\\n"); process.exitCode = 1; }, 30);',
    ].join("\n"),
  );
  await writeFile(path.join(game, "scenes/β.chapter.txt"), "*ending");

  const events: JobEvent[] = [];
  const runner = new ToolRunner(fakeEngine, (event) => events.push(event));

  try {
    const [project] = await discoverProjects([game]);
    const job = await runner.start(request, project, []);
    await waitFor(() => events.find((event) => event.jobId === job.jobId && event.kind === "completed"));

    const diagnostic = events.find((event) => event.jobId === job.jobId && event.kind === "diagnostic");

    assert.equal(diagnostic?.message, "café");
    assert.equal(diagnostic?.line, 1);
    assert.equal(diagnostic?.uri, pathToFileURL(path.join(game, "scenes/β.chapter.txt")).href);
    assert(events.some((event) => event.message === "separate stderr"));
    assert(!events.some((event) => event.message?.includes("\uFFFD")));
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "asset staging omits nested links and common development secrets",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil assets "));
    const { fakeEngine, game } = await createGameFixture(root);
    await mkdir(path.join(game, "images"));
    await writeFile(path.join(fakeEngine, "mygamegenerator.js"), 'console.log("generated")');
    await writeFile(path.join(game, ".env"), "SECRET=private");
    await writeFile(path.join(game, "images/private.key"), "private key");
    await writeFile(path.join(game, "images/picture.png"), "public asset");
    await symlink(path.join(game, ".env"), path.join(game, "images/linked.png"));

    const runner = new ToolRunner(fakeEngine, () => {});
    let stage: string | undefined;

    try {
      const [project] = await discoverProjects([game]);
      stage = await runner.stage(project, []);

      const staged = path.join(stage, "web/mygame");

      assert.equal(await readFile(path.join(staged, "images/picture.png"), "utf8"), "public asset");

      for (const file of [".env", "images/private.key", "images/linked.png"])
        await assert.rejects(readFile(path.join(staged, file)), { code: "ENOENT" });
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });

      await runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "cleanup failure settles cancellation and retains a directory for a later retry",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const { chmod, access } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil cleanup "));
    const { fakeEngine, game } = await createGameFixture(root);
    await writeFile(path.join(fakeEngine, "mygamegenerator.js"), 'console.log("generated")');
    await writeFile(path.join(fakeEngine, "quicktest.js"), "setInterval(() => {}, 1000)");

    const events: JobEvent[] = [];
    const runner = new ToolRunner(fakeEngine, (event) => events.push(event));
    let stage: string | undefined;

    try {
      const [project] = await discoverProjects([game]);
      const job = await runner.start(request, project, []);
      stage = runner.jobs.get(job.jobId)!.stage;
      await chmod(stage, 0o500);
      await runner.stop(job.jobId);

      assert(events.some((event) => event.kind === "completed" && event.jobId === job.jobId && event.exitCode === 130));
      assert(events.some((event) => event.message?.startsWith("Could not remove temporary directory")));
      assert.equal(runner.jobs.size, 0);

      await chmod(stage, 0o700);
      await runner.dispose();
      await assert.rejects(access(stage), { code: "ENOENT" });
    } finally {
      if (stage) await chmod(stage, 0o700).catch(() => {});

      await runner.dispose();
      if (stage) await rm(stage, { recursive: true, force: true });

      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "edits during preparation keep the captured buffers stale rather than rebasing their revision",
  { timeout: 10_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil snapshot "));
    const { fakeEngine, game } = await createGameFixture(root);
    await writeFile(path.join(fakeEngine, "mygamegenerator.js"), 'console.log("generated")');
    await writeFile(path.join(fakeEngine, "web/mygame/index.html"), "Preview");

    const file = path.join(game, "scenes/startup.txt");
    await writeFile(file, "*ending");

    const events: JobEvent[] = [];
    const runner = new ToolRunner(fakeEngine, (event) => events.push(event));

    try {
      const [project] = await discoverProjects([game]);
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = runner.stage.bind(runner);
      runner.stage = async (...args) => {
        await barrier;
        return original(...args);
      };

      const buffers = [{ uri: pathToFileURL(file).href, text: "Captured.\n*ending", version: 1 }];
      const pending = runner.start({ ...request, operation: "run" }, project, buffers);
      buffers[0].text = "Edited.\n*ending";
      buffers[0].version = 2;
      runner.markStale(project.id);
      release();

      const result = await pending;
      const staged = await (await fetch(new URL("scenes/startup.txt", result.url))).text();

      assert(staged.startsWith("Captured."));
      assert(!staged.includes("Edited."));
      assert(events.some((event) => event.jobId === result.jobId && event.kind === "preview" && event.stale));

      await runner.stop(result.jobId);
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("preparation output limits fail locally and settle the registered job", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil output limit "));
  const { fakeEngine, game } = await createGameFixture(root);
  await writeFile(
    path.join(fakeEngine, "mygamegenerator.js"),
    "for (let i=0; i<64; i++) process.stdout.write(Buffer.alloc(1024*1024, 65));",
  );

  const events: JobEvent[] = [];
  const runner = new ToolRunner(fakeEngine, (event) => events.push(event));

  try {
    const [project] = await discoverProjects([game]);
    await assert.rejects(runner.start(request, project, []), /16 MiB output limit/);

    assert.equal(runner.jobs.size, 0);
    assert.equal(events.find((event) => event.kind === "completed")?.exitCode, 1);
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent project creation never overwrites a populated template", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil create race "));
  const fakeEngine = path.join(root, "engine");
  await mkdir(path.join(fakeEngine, "web/mygame"), { recursive: true });
  await writeFile(path.join(fakeEngine, "web/mygame/index.html"), "Template");
  await writeFile(path.join(fakeEngine, "LICENSE.txt"), "Upstream license");

  const runner = new ToolRunner(fakeEngine, () => {});

  try {
    const destination = path.join(root, "game");
    const results = await Promise.allSettled([runner.createProject(destination), runner.createProject(destination)]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    await writeFile(path.join(destination, "index.html"), "User content");
    await assert.rejects(runner.createProject(destination), /empty directory/);

    assert.equal(await readFile(path.join(destination, "index.html"), "utf8"), "User content");
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling during export stops companion copying and settles completion", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil export cancel "));
  const { fakeEngine, game } = await createGameFixture(root);
  await writeFile(path.join(fakeEngine, "mygamegenerator.js"), 'console.log("generated")');
  await writeFile(path.join(fakeEngine, "compile.js"), 'require("node:fs").writeFileSync("export.html", "Compiled")');

  const events: JobEvent[] = [];
  const runner = new ToolRunner(fakeEngine, (event) => events.push(event));

  try {
    const [project] = await discoverProjects([game]);
    const dest = path.join(root, "export/game.html");
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const copy = (runner as any).copySnapshot.bind(runner);
    (runner as any).copySnapshot = async (...args: any[]) => {
      if (args[1] === dest) {
        reached();
        await barrier;
      }

      return copy(...args);
    };

    const result = await runner.start({ ...request, operation: "exportHtml", destination: dest }, project, []);
    await entered;

    const stopped = runner.stop(result.jobId);
    release();
    await stopped;

    assert.equal(events.find((event) => event.jobId === result.jobId && event.kind === "completed")?.exitCode, 130);

    await assert.rejects(readFile(dest), { code: "ENOENT" });
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup directories do not claim unrelated text as a game", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil invalid startup "));

  try {
    await mkdir(path.join(root, "scenes/startup.txt"), { recursive: true });
    await writeFile(path.join(root, "scenes/notes.txt"), "Ordinary notes.");

    assert.deepEqual(await discoverProjects([root]), []);

    await writeFile(path.join(root, "choicescript.json"), '{"scenes":"scenes"}');

    assert.deepEqual(await discoverProjects([root]), []);

    await rm(path.join(root, "scenes/startup.txt"), { recursive: true });
    await writeFile(path.join(root, "scenes/startup.txt"), "*ending");

    assert.equal((await discoverProjects([root])).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "different games share one tool process and a queued preparation remains cancellable",
  { timeout: 10_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil process budget "));
    const { fakeEngine, game } = await createGameFixture(root);
    await writeFile(path.join(fakeEngine, "mygamegenerator.js"), "setInterval(() => {}, 1000)");

    const other = path.join(root, "other");
    await mkdir(path.join(other, "scenes"), { recursive: true });
    await writeFile(path.join(other, "scenes/startup.txt"), "*ending");

    const events: JobEvent[] = [];
    const runner = new ToolRunner(fakeEngine, (event) => events.push(event));

    try {
      const projects = await discoverProjects([game, other]);
      const firstId = randomUUID(),
        secondId = randomUUID();
      const first = runner.start({ ...request, jobId: firstId }, projects[0], []);
      const firstRejected = assert.rejects(first, /cancelled|aborted/i);
      await waitFor(() => runner.jobs.get(firstId)?.child);

      const second = runner.start({ ...request, jobId: secondId }, projects[1], []);
      const secondRejected = assert.rejects(second, /cancelled|aborted/i);
      await waitFor(() => runner.jobs.get(secondId)?.stage);
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(runner.jobs.get(secondId)?.child, undefined);
      assert(runner.jobs.get(firstId)?.child);

      await runner.stop(secondId);
      await secondRejected;

      assert.equal(events.find((event) => event.jobId === secondId && event.kind === "completed")?.exitCode, 130);
      assert(runner.jobs.get(firstId)?.child);

      await runner.stop(firstId);
      await firstRejected;
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("coverage is complete in saved output without flooding editor events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil coverage output Ω "));
  const { fakeEngine, game } = await createGameFixture(root);
  await writeFile(path.join(fakeEngine, "mygamegenerator.js"), "console.log('var stats = {};');");
  await writeFile(
    path.join(fakeEngine, "randomtest.js"),
    "console.log('Word count: 1'); console.log('startup 999: Deliberate source text.');",
  );
  const events: JobEvent[] = [];
  const runner = new ToolRunner(fakeEngine, (event) => events.push(event));
  try {
    const [project] = await discoverProjects([game]);
    for (const showText of [false, true]) {
      const result = await runner.start({ ...request, operation: "randomtest", iterations: 1, showText }, project, []);
      const completed = await waitFor(() =>
        events.find((event) => event.jobId === result.jobId && event.kind === "completed"),
      );
      assert.equal(completed?.exitCode, 0);
      const jobEvents = events.filter((event) => event.jobId === result.jobId);
      assert.ok((await readFile(completed!.message!, "utf8")).includes("startup 999: Deliberate source text."));
      const coverage = jobEvents.find((event) => event.kind === "coverage");
      if (showText) {
        assert.equal(coverage, undefined, "printed prose was interpreted as coverage");
        assert.ok(
          jobEvents.some(
            (event) => event.kind === "output" && event.message === "startup 999: Deliberate source text.",
          ),
        );
      } else {
        assert.deepEqual(coverage?.coverage?.startup, [999]);
        assert.equal(
          jobEvents.some(
            (event) => event.kind === "output" && event.message === "startup 999: Deliberate source text.",
          ),
          false,
        );
      }
    }
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
