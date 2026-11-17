import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JobEvent, JobRequest } from "@bifoil/choicescript-protocol";
import { discoverProjects, ToolRunner } from "@bifoil/choicescript-tooling";

const engine = fileURLToPath(new URL("../../../vendor/choicescript", import.meta.url));

test("direct runner requests reject invalid protocol, identity and lifecycle states before launch", async () => {
  const events: JobEvent[] = [];
  const runner = new ToolRunner(engine, (event) => events.push(event));
  const root = path.join(os.tmpdir(), "bifoil uncreated validation fixture");
  const project = { id: "original", name: "Original", root, sceneDir: path.join(root, "scenes"), assetDir: root };
  const base: JobRequest = { protocolVersion: 1, operation: "quicktest", trusted: true };
  try {
    for (const [request, error] of [
      [{ ...base, protocolVersion: 2 }, /Unsupported tooling protocol/],
      [{ ...base, operation: "createProject" }, /Unknown tooling operation/],
      [{ ...base, jobId: "invalid identity" }, /UUID/],
      [{ ...base, operation: "randomtest", iterations: 2, seed: Number.MAX_SAFE_INTEGER }, /safe integer range/i],
    ] as const) {
      await assert.rejects(runner.start(request as unknown as JobRequest, project, []), error);
      assert.equal(runner.jobs.size, 0);
      assert.deepEqual(events, []);
    }
    await runner.dispose();
    await assert.rejects(runner.createProject(root), /shutting down/);
    await assert.rejects(runner.start(base, project, []), /shutting down/);
    assert.deepEqual(await runner.start({ ...base, operation: "stop" }, project, []), {
      jobId: "",
      projectId: "original",
    });
  } finally {
    await runner.dispose();
  }
});

test(
  "preview checks nonce paths, physical containment, job ownership and retired identities",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil preview boundary Ω "));
    const events: JobEvent[] = [];
    const runner = new ToolRunner(engine, (event) => events.push(event));
    try {
      await mkdir(path.join(root, "scenes"));
      await writeFile(
        path.join(root, "scenes/startup.txt"),
        "*title Original\n*author Original\nOriginal scene.\n*ending",
      );
      const [project] = await discoverProjects([root]);
      const jobId = randomUUID();
      const request: JobRequest = { protocolVersion: 1, operation: "run", trusted: true, jobId };
      const result = await runner.start(request, project, []);
      const base = new URL("../", result.url);
      const stage = runner.jobs.get(jobId)!.stage;
      await writeFile(path.join(stage, "web/original.bin"), "Original opaque asset");
      await mkdir(path.join(stage, "web/original-folder"));
      await writeFile(path.join(stage, "web/original-folder/index.html"), "Original folder page");
      assert.equal((await fetch(base)).status, 200);
      assert.equal((await fetch(new URL("/outside-the-nonce", base))).status, 404);
      assert.equal((await fetch(new URL("%2Foutside-the-stage", base))).status, 403);
      const asset = await fetch(new URL("original.bin", base));
      assert.equal(asset.headers.get("content-type"), "application/octet-stream");
      assert.equal(await asset.text(), "Original opaque asset");
      assert.equal(await (await fetch(new URL("original-folder/", base))).text(), "Original folder page");
      if (process.platform !== "win32") {
        const outside = path.join(root, "outside.txt");
        await writeFile(outside, "Original private fixture outside the stage");
        await symlink(outside, path.join(stage, "web/outside-link.txt"));
        assert.equal((await fetch(new URL("outside-link.txt", base))).status, 403);
      }
      await assert.rejects(runner.stopProject("another-project", jobId), /belongs to another project/);
      assert.equal((await fetch(result.url!)).status, 200);
      await assert.rejects(runner.start(request, project, []), /already in use/);
      await runner.stopProject(project.id, jobId);
      await assert.rejects(runner.start(request, project, []), /already in use/);
      assert.equal(runner.jobs.size, 0);
      assert.equal(events.filter((event) => event.kind === "completed").length, 1);
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
