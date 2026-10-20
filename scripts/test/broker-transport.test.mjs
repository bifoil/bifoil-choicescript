import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { buildCoverageTests } from "../coverage-build.mjs";
import { repositoryRoot } from "../artifact-paths.mjs";

test("private tooling transport rejects malformed requests and settles shutdown without losing replies", async () => {
  const [entry] = await buildCoverageTests(["packages/tooling/src/broker.ts"]);
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil private pipe Ω "));
  const child = spawn(process.execPath, [entry, path.join(repositoryRoot, "dist/server")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const messages = [];
  const input = createInterface({ input: child.stdout });
  let serial = 0,
    errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  input.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const raw = (line) => child.stdin.write(line + "\n");
  const response = (id) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No private reply for " + id + ": " + errors)), 10000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  const call = async (method, params) => {
    const id = ++serial,
      result = response(id);
    raw(JSON.stringify({ id, method, params }));
    return result;
  };
  try {
    for (const malformed of ["{", "null", "[]", "1", '"text"', "{}", '{"method":1}']) {
      const result = response(null);
      raw(malformed);
      assert.match((await result).error.message, /Malformed private tooling message/);
    }
    for (const params of [
      undefined,
      { request: { protocolVersion: 2 } },
      { request: { protocolVersion: 1, operation: "run", trusted: false } },
      { request: { protocolVersion: 1, operation: "createProject", trusted: true } },
      { request: { protocolVersion: 1, operation: "run", trusted: true } },
    ])
      assert((await call("job", params)).error);
    assert.match((await call("unknown", {})).error.message, /Unknown private/);
    const destination = path.join(root, "created");
    assert.deepEqual(
      (await call("job", { request: { protocolVersion: 1, operation: "createProject", trusted: true, destination } }))
        .result,
      { jobId: "created", projectId: destination },
    );
    assert((await readFile(path.join(destination, "scenes/startup.txt"), "utf8")).length > 0);
    raw(JSON.stringify({ method: "stale", params: { projectId: "original" } }));
    assert.equal((await call("stale", {})).result, null);
    assert((await call("job", { request: { protocolVersion: 1, operation: "stop", trusted: false } })).result);
    const terminal = ++serial,
      rejected = ++serial;
    const stopped = response(terminal),
      denied = response(rejected);
    // Deliver the requests in one pipe write. A request sent after the input
    // has already closed cannot be expected to receive a shutdown reply.
    raw(
      [
        { id: terminal, method: "dispose" },
        { id: rejected, method: "unknown" },
        { method: "stale" },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n"),
    );
    assert.match((await denied).error.message, /stopping/);
    assert.equal((await stopped).result, null);
    child.stdin.end();
    if (child.exitCode === null) await once(child, "exit");
    assert.equal(child.exitCode, 0, errors);
    assert(messages.some((message) => message.id === terminal));
  } finally {
    child.kill();
    input.close();
    await rm(root, { recursive: true, force: true });
  }
});
