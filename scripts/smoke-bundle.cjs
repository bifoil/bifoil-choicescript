// Dependency-free smoke test: run this with the bundled Node executable on each OS.
const { spawn } = require("node:child_process");
const { readFile, mkdtemp, rm, cp } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const server = spawn(
  process.execPath,
  [
    process.env.BRANCHLIGHT_SERVER_PATH ||
      path.join(root, "dist/server/server.cjs"),
    "--stdio",
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const pending = new Map(),
  events = [],
  diagnostics = [];
let serial = 0,
  buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  server.stdin.write("Content-Length: " + body.length + "\r\n\r\n");
  server.stdin.write(body);
}
function request(method, params) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout: " + method)),
      30000,
    );
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    send({ id, method, params });
  });
}
server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const len = Number(
      /Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1],
    );
    if (buffer.length < end + 4 + len) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + len));
    buffer = buffer.subarray(end + 4 + len);
    if (message.method) {
      if (message.id !== undefined) send({ id: message.id, result: null });
      if (message.method === "choicescript/jobEvent")
        events.push(message.params);
      if (message.method === "textDocument/publishDiagnostics")
        diagnostics.push(message.params);
    } else {
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id);
        message.error ? p.reject(message.error) : p.resolve(message.result);
      }
    }
  }
});
async function waitFor(get) {
  for (let i = 0; i < 600; i++) {
    const value = get();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for server event");
}
(async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "Branchlight Ω "));
  try {
    const folder = path.join(temporary, "game Ω");
    await cp(path.join(root, "fixtures/dialogue"), folder, { recursive: true });
    const file = path.join(folder, "scenes/startup.txt"),
      uri = pathToFileURL(file).href;
    const fixture = await readFile(file, "utf8");
    const init = await request("initialize", {
      processId: process.pid,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(folder).href, name: "dialogue" }],
    });
    send({ method: "initialized", params: {} });
    send({
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: "choicescript",
          version: 1,
          text: await readFile(file, "utf8"),
        },
      },
    });
    await waitFor(() => diagnostics.find((d) => d.version === 1));
    const tokens = await request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    assert(tokens.data.length);
    assert(
      !diagnostics
        .flatMap((d) => d.diagnostics)
        .some((d) => d.code.startsWith("quote-")),
    );
    const [project] = await request("choicescript/projects");
    assert(project);
    for (const operation of ["quicktest", "randomtest", "exportHtml"]) {
      const job = await request("choicescript/job", {
        protocolVersion: 1,
        operation,
        projectId: project.id,
        trusted: true,
        seed: 7,
        iterations: 2,
        destination: path.join(temporary, "game.html"),
      });
      const done = await waitFor(() =>
        events.find((e) => e.jobId === job.jobId && e.kind === "completed"),
      );
      assert.equal(
        done.exitCode,
        0,
        JSON.stringify(events.filter((e) => e.jobId === job.jobId)),
      );
    }
    const original = await readFile(path.join(temporary, "game.html"), "utf8");
    const collision = await request("choicescript/job", {
      protocolVersion: 1,
      operation: "exportHtml",
      projectId: project.id,
      trusted: true,
      destination: path.join(temporary, "game.html"),
    });
    assert.equal(
      (
        await waitFor(() =>
          events.find(
            (e) => e.jobId === collision.jobId && e.kind === "completed",
          ),
        )
      ).exitCode,
      1,
    );
    assert.equal(
      await readFile(path.join(temporary, "game.html"), "utf8"),
      original,
    );
    send({
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            text: "*title Bad\n*author Test\n*print missing_variable\n*ending",
          },
        ],
      },
    });
    const failure = await request("choicescript/job", {
      protocolVersion: 1,
      operation: "quicktest",
      projectId: project.id,
      trusted: true,
    });
    assert.equal(
      (
        await waitFor(() =>
          events.find(
            (e) => e.jobId === failure.jobId && e.kind === "completed",
          ),
        )
      ).exitCode,
      1,
    );
    assert(
      events.some(
        (e) =>
          e.jobId === failure.jobId && e.kind === "diagnostic" && e.line === 2,
      ),
    );
    assert(
      (await readFile(failure.output, "utf8")).includes("missing_variable"),
    );
    send({
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 3 },
        contentChanges: [
          { text: fixture.replace("William", "Snapshot William") },
        ],
      },
    });
    const cancel = await request("choicescript/job", {
      protocolVersion: 1,
      operation: "randomtest",
      projectId: project.id,
      trusted: true,
      iterations: 10000000,
    });
    await request("choicescript/job", {
      protocolVersion: 1,
      operation: "stop",
      projectId: project.id,
      jobId: cancel.jobId,
    });
    assert.equal(
      (
        await waitFor(() =>
          events.find(
            (e) => e.jobId === cancel.jobId && e.kind === "completed",
          ),
        )
      ).exitCode,
      130,
    );
    const preview = await request("choicescript/job", {
      protocolVersion: 1,
      operation: "run",
      projectId: project.id,
      trusted: true,
    });
    assert.equal((await fetch(preview.url)).status, 200);
    assert(
      (
        await (await fetch(new URL("scenes/startup.txt", preview.url))).text()
      ).includes("Snapshot William"),
    );
    send({
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 4 },
        contentChanges: [{ text: fixture }],
      },
    });
    await waitFor(() =>
      events.find(
        (e) => e.jobId === preview.jobId && e.kind === "stale" && e.stale,
      ),
    );
    const restarted = await request("choicescript/job", {
      protocolVersion: 1,
      operation: "run",
      projectId: project.id,
      trusted: true,
    });
    await assert.rejects(fetch(preview.url));
    assert.equal((await fetch(restarted.url)).status, 200);
    await request("shutdown");
    await assert.rejects(fetch(restarted.url));
    send({ method: "exit" });
    console.log(
      "Bundled runtime smoke passed on " +
        process.platform +
        " " +
        process.arch +
        " (" +
        process.version +
        ").",
    );
  } finally {
    server.kill();
    await rm(temporary, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  server.kill();
  process.exitCode = 1;
});
