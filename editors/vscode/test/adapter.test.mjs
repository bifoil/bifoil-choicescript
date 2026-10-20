import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const compiled = path.join(root, ".cache/coverage/editor-adapter.cjs");
mkdirSync(path.dirname(compiled), { recursive: true });
const code = buildSync({
  entryPoints: [path.join(root, "editors/vscode/src/extension.ts")],
  bundle: true,
  alias: { "@bifoil/choicescript-protocol": path.join(root, "packages/protocol/src/index.ts") },
  platform: "node",
  format: "cjs",
  sourcemap: "inline",
  outfile: compiled,
  external: ["vscode", "vscode-languageclient/node"],
  write: false,
}).outputFiles[0].text;
writeFileSync(compiled, code);

class Signal {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}
class ResponseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const disposable = () => ({ dispose() {} });
const uri = (file) => ({ scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href });
const game = (id) => ({
  id,
  name: id,
  root: path.join(root, "fixtures", id),
  sceneDir: path.join(root, "fixtures", id, "scenes"),
  assetDir: path.join(root, "fixtures", id, "assets"),
});
function document(file, languageId = "plaintext") {
  const text = "First line.\nSecond line.\nThird line.";
  return {
    uri: uri(file),
    fileName: file,
    languageId,
    lineCount: 3,
    getText: () => text,
    lineAt: (line) => ({ range: { start: { line }, end: { line } } }),
  };
}

// Only editor APIs and the remote client are substituted. The adapter, protocol
// validation and coverage store execute their actual production code. Requests,
// UI effects and subscriptions are observed as public boundary contracts.
async function adapter(options = {}) {
  const games = options.games ?? [game("dialogue")];
  const commands = new Map(),
    requests = [],
    messages = [],
    notifications = [],
    decorations = [],
    edits = [],
    panels = [];
  const documents = options.documents ?? [];
  const changes = new Signal(),
    opened = new Signal(),
    visible = new Signal(),
    ranges = new Signal();
  const inputs = [],
    folders = [],
    saves = [],
    picks = [];
  const state = {
    games,
    commands,
    requests,
    messages,
    notifications,
    decorations,
    edits,
    panels,
    documents,
    changes,
    opened,
    visible,
    ranges,
    inputs,
    folders,
    saves,
    picks,
    cancelled: false,
  };
  const window = {
    activeTextEditor: options.active,
    visibleTextEditors: options.editors ?? [],
    createOutputChannel: () => ({ appendLine: (value) => messages.push(value), show() {}, dispose() {} }),
    createTextEditorDecorationType: disposable,
    onDidChangeVisibleTextEditors: visible.event,
    onDidChangeTextEditorVisibleRanges: ranges.event,
    showInformationMessage: async (value) => messages.push(value),
    showErrorMessage: async (value) => messages.push(value),
    showInputBox: async (settings) => {
      state.lastInput = settings;
      return inputs.shift();
    },
    showOpenDialog: async (settings) => {
      state.lastOpen = settings;
      return folders.shift();
    },
    showSaveDialog: async (settings) => {
      state.lastSave = settings;
      return saves.shift();
    },
    showQuickPick: async (items) => {
      state.lastPicks = items;
      return picks.shift();
    },
    withProgress: async (_, action) => {
      const cancel = new Signal();
      state.cancel = () => cancel.fire();
      return action(
        { report: (value) => messages.push(value.message) },
        { isCancellationRequested: state.cancelled, onCancellationRequested: cancel.event },
      );
    },
    createWebviewPanel: () => {
      const closed = new Signal();
      const panel = {
        title: "Game Preview",
        webview: { html: "" },
        onDidDispose: closed.event,
        dispose() {
          closed.fire();
          closed.dispose();
        },
      };
      panels.push(panel);
      return panel;
    },
  };
  const vscode = {
    window,
    workspace: {
      isTrusted: true,
      textDocuments: documents,
      onDidChangeTextDocument: changes.event,
      onDidOpenTextDocument: opened.event,
    },
    languages: {
      async setTextDocumentLanguage(doc, language) {
        doc.languageId = language;
      },
    },
    commands: {
      registerCommand(name, action) {
        commands.set(name, action);
        return disposable();
      },
      async executeCommand(name, ...args) {
        edits.push({ name, args });
      },
    },
    Uri: { file: uri, parse: (value) => uri(fileURLToPath(value)) },
    ThemeColor: class {
      constructor(name) {
        this.name = name;
      }
    },
    EventEmitter: Signal,
    ProgressLocation: { Notification: 1 },
    ViewColumn: { Beside: 2 },
  };
  class LanguageClient {
    state = 2;
    handlers = new Map();
    changed = new Signal();
    constructor() {
      state.client = this;
    }
    onNotification(name, action) {
      this.handlers.set(name, action);
      return disposable();
    }
    onDidChangeState = this.changed.event;
    async start() {}
    async stop() {
      this.state = 3;
      this.changed.fire({ newState: 3 });
    }
    async sendNotification(name, params) {
      notifications.push({ name, params });
      if (state.notificationError) throw Error("Notification failed");
    }
    async sendRequest(name, params) {
      requests.push({ name, params });
      if (name === "choicescript/projects") return state.games;
      if (name === "choicescript/wordCount") return 3;
      if (state.job) return state.job(params);
      const result = {
        jobId: params.jobId ?? "preview",
        projectId: params.projectId ?? "new",
        ...(params.operation === "run" ? { url: 'http://127.0.0.1:3456/?a=1&b="x"' } : {}),
      };
      if (["quicktest", "randomtest", "exportHtml"].includes(params.operation)) {
        this.handlers.get("choicescript/jobEvent")({
          kind: "completed",
          jobId: result.jobId,
          projectId: result.projectId,
          exitCode: 0,
        });
      }
      return result;
    }
  }
  const require = createRequire(compiled);
  const loaded = new Module(compiled);
  loaded.require = (name) =>
    name === "vscode"
      ? vscode
      : name === "vscode-languageclient/node"
        ? {
            LanguageClient,
            ResponseError,
            LSPErrorCodes: { RequestCancelled: -32800 },
            State: { Running: 2, Stopped: 3 },
          }
        : require(name);
  loaded._compile(code, compiled);
  const context = { subscriptions: [], asAbsolutePath: (file) => path.join(root, "editors/vscode", file) };
  state.api = await loaded.exports.activate(context);
  state.vscode = vscode;
  state.run = (name, args) => commands.get("bifoil.choicescript." + name)(args);
  state.emit = (name, value) => state.client.handlers.get(name)(value);
  state.close = async () => {
    for (const item of context.subscriptions) item.dispose();
    await loaded.exports.deactivate();
  };
  return state;
}

test("adapter associates detected scenes and exposes current projects without claiming notes", async (t) => {
  const project = game("dialogue"),
    doc = document(path.join(project.sceneDir, "startup.txt"));
  const notes = document(path.join(project.root, "notes.txt"));
  const selected = document(path.join(project.sceneDir, "other.txt"), "markdown");
  const a = await adapter({ documents: [doc, notes, selected] });
  t.after(a.close);
  assert.equal(doc.languageId, "choicescript");
  assert.equal(notes.languageId, "plaintext");
  assert.equal(selected.languageId, "markdown");
  assert.deepEqual(a.api.projects(), [project]);
  a.emit("choicescript/projectsChanged", { protocolVersion: 2, projects: [] });
  assert.equal(a.api.projects().length, 1);
  a.emit("choicescript/projectsChanged", { protocolVersion: 1, projects: [] });
  assert.deepEqual(a.api.projects(), []);
  const next = document(path.join(project.sceneDir, "later.txt"));
  a.opened.fire(next);
  assert.equal(next.languageId, "plaintext");
});

test("adapter requires trust for execution while stop remains available", async (t) => {
  const a = await adapter({ games: [] });
  t.after(a.close);
  a.vscode.workspace.isTrusted = false;
  await a.run("quicktest");
  assert.equal(a.edits.at(-1).name, "workbench.trust.manage");
  assert(!a.requests.some((r) => r.name === "choicescript/job"));
  await a.run("stop", { jobId: "owned" });
  assert.equal(a.requests.at(-1).params.jobId, "owned");
  assert.equal(a.requests.at(-1).params.operation, "stop");
  a.vscode.workspace.isTrusted = true;
  await a.run("run");
  assert(a.messages.some((m) => String(m).includes("Open a folder")));
});

test("adapter retains visible coverage, invalidates edits, and separates asset events", async (t) => {
  const project = game("dialogue"),
    doc = document(path.join(project.sceneDir, "startup.txt"), "choicescript");
  const editor = {
    document: doc,
    visibleRanges: [
      { start: { line: 0 }, end: { line: 2 } },
      { start: { line: 1 }, end: { line: 2 } },
    ],
    setDecorations: (_, values) => records.push(values),
  };
  const records = [],
    a = await adapter({ editors: [editor] });
  t.after(a.close);
  a.emit("choicescript/jobEvent", { kind: "started", projectId: project.id, jobId: "one" });
  a.emit("choicescript/jobEvent", {
    kind: "coverage",
    projectId: project.id,
    jobId: "one",
    coverage: { startup: [1, 0, 3] },
  });
  assert.deepEqual(
    records.at(-1).map((d) => d.range.start.line),
    [0, 2],
  );
  a.visible.fire([]);
  a.ranges.fire({ editor });
  a.changes.fire({ document: doc, contentChanges: [] });
  assert.equal(records.at(-1).length, 2);
  a.changes.fire({ document: doc, contentChanges: [{}] });
  assert.deepEqual(records.at(-1), []);
  const asset = document(path.join(project.assetDir, "cover.txt"));
  a.changes.fire({ document: asset, contentChanges: [{}] });
  assert.equal(a.notifications.at(-1).name, "choicescript/assetChanged");
  a.notificationError = true;
  a.changes.fire({ document: asset, contentChanges: [{}] });
  await new Promise((resolve) => setImmediate(resolve));
  assert(a.messages.some((m) => String(m).includes("Notification failed")));
});

test("adapter finishes immediate jobs and exposes real diagnostic/progress notifications", async (t) => {
  const a = await adapter();
  t.after(a.close);
  const events = [];
  a.api.onJobEvent((event) => events.push(event));
  const result = await a.run("quicktest", { projectId: "dialogue" });
  assert.match(result.jobId, /^[a-f0-9-]{36}$/);
  assert.equal(events.at(-1).exitCode, 0);
  a.emit("choicescript/jobEvent", {
    kind: "diagnostic",
    jobId: "failure",
    projectId: "dialogue",
    uri: pathToFileURL(path.join(root, "fixtures/dialogue/scenes/startup.txt")).href,
    line: 2,
    message: "Original failure",
  });
  assert(a.messages.some((m) => String(m).includes(":3: Original failure")));
  a.emit("choicescript/jobEvent", { kind: "completed", jobId: "failure", projectId: "dialogue", exitCode: 1 });
  assert(a.messages.some((m) => String(m).includes("operation failed")));
});

test("adapter cancellation and server disconnect settle pending progress without hiding errors", async (t) => {
  const a = await adapter();
  t.after(a.close);
  a.cancelled = true;
  a.job = async (request) => {
    if (request.operation !== "stop") throw new ResponseError(-32800, "Cancelled");
    return { jobId: request.jobId };
  };
  await a.run("quicktest");
  assert(a.requests.some((r) => r.params?.operation === "stop"));
  assert(!a.messages.some((m) => String(m).includes("Error: Cancelled")));
  a.cancelled = false;
  a.job = async () => {
    throw Error("Real failure");
  };
  await a.run("exportHtml", { destination: path.join(root, "dist/export.html") });
  assert(a.messages.some((m) => String(m).includes("Real failure")));
  a.job = async (request) => {
    await a.client.stop();
    return { jobId: request.jobId };
  };
  await a.run("quicktest");
  assert(a.messages.some((m) => String(m).includes("Language server stopped")));
});

test("preview restarts replace panels and stale events identify the old snapshot", async (t) => {
  const a = await adapter();
  t.after(a.close);
  await a.run("run");
  const first = a.panels[0];
  assert(first.webview.html.includes("&amp;"));
  assert(first.webview.html.includes("&quot;"));
  a.emit("choicescript/jobEvent", { kind: "stale", jobId: "preview", projectId: "dialogue" });
  assert.equal(first.title, "Game Preview — source changed");
  await a.run("run");
  assert.equal(a.panels.length, 2);
  assert(a.requests.filter((r) => r.params?.operation === "stop").length >= 3);
  await a.client.stop();
  assert(a.messages.some((m) => String(m).includes("active operations ended")));
});

test("creation, export and randomtest dialogs preserve exact user selections", async (t) => {
  const a = await adapter();
  t.after(a.close);
  a.folders.push([uri(path.join(root, "dist"))]);
  a.inputs.push("Original game");
  await a.run("createProject");
  assert.equal(a.edits.at(-1).name, "vscode.openFolder");
  assert.equal(a.lastInput.validateInput("bad/name"), "Use letters, digits, spaces, dashes, or underscores.");
  a.inputs.push("2", "-2147483649");
  await a.run("randomtest");
  const request = a.requests.filter((r) => r.params?.operation === "randomtest").at(-1).params;
  assert.equal(request.iterations, 2);
  assert.equal(request.seed, -2147483649);
  assert(a.lastInput.validateInput("9007199254740991"));
  assert.equal(a.lastInput.validateInput("1"), undefined);
  a.saves.push(uri(path.join(root, "dist/game.html")));
  await a.run("exportHtml");
  assert.equal(a.requests.at(-1).params.destination, path.join(root, "dist/game.html"));
  assert.deepEqual(a.lastSave.filters, { HTML: ["html"] });
  const before = a.requests.length;
  await a.run("exportHtml");
  await a.run("createProject");
  await a.run("randomtest");
  assert.equal(a.requests.length, before);
});

test("project selection, markup actions, word counts and about remain editor operations", async (t) => {
  const projects = [game("dialogue"), game("other")],
    doc = document(path.join(projects[1].sceneDir, "startup.txt"));
  const edits = [],
    editor = { document: doc, selections: [{}], edit: (action) => action({ replace: (...args) => edits.push(args) }) };
  const a = await adapter({ games: projects, active: editor });
  t.after(a.close);
  await a.run("quicktest");
  assert.equal(a.requests.at(-1).params.projectId, "other");
  await a.run("bold");
  await a.run("italic");
  assert(edits[0][1].startsWith("[b]"));
  assert(edits[1][1].endsWith("[/i]"));
  assert.equal(await a.run("wordCount"), 3);
  await a.run("about");
  assert(a.messages.some((m) => String(m).includes("unaffiliated")));
  a.vscode.window.activeTextEditor = undefined;
  assert.equal(await a.run("wordCount"), undefined);
  await a.run("bold");
  a.picks.push({ project: projects[0] });
  await a.run("quicktest");
  assert.equal(a.requests.at(-1).params.projectId, "dialogue");
  await a.run("quicktest");
  assert(a.messages.some((m) => String(m).includes("Open a folder")));
});
