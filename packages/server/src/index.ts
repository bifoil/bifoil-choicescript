import {
  createConnection,
  type Diagnostic,
  DidChangeWatchedFilesNotification,
  ErrorCodes,
  LSPErrorCodes,
  ProposedFeatures,
  ResponseError,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import path from "node:path";
import {
  type Analysis,
  completions,
  definition,
  documentSymbols,
  encodeTokens,
  folding,
  hover,
  prepareRename,
  references,
  rename,
  selections,
  tokenModifiers,
  tokenTypes,
} from "@bifoil/choicescript-core";
import { affectedProjects, contains, discoverProjects, projectFor, readProject, sameFileUri, ToolRunner } from "@bifoil/choicescript-tooling";
import { type BufferSnapshot, commands, type JobRequest, type Project, PROTOCOL_VERSION } from "@bifoil/choicescript-protocol";

const connection = createConnection(ProposedFeatures.all),
  documents = new TextDocuments(TextDocument);
const arg = process.argv.indexOf("--bundle-root"),
  bundle = arg >= 0 ? path.resolve(process.argv[arg + 1]) : __dirname;
let roots: string[] = [],
  projects: Project[] = [],
  quoteWarnings = true,
  revision = 0,
  timer: NodeJS.Timeout | undefined,
  disposed = false;
const analysisVersions = new Map<string, number>();
const analyses = new Map<string, Analysis>(),
  workers = new Set<Worker>();
const snapshots = (): BufferSnapshot[] =>
  documents
    .all()
    .filter((d) => d.uri.startsWith("file:"))
    .map((d) => ({ uri: d.uri, text: d.getText(), version: d.version }));
const testResults = new Map<string, { jobId: string; stale: boolean; diagnostics: Map<string, Diagnostic[]> }>();
const configDiagnostics = new Map<string, Diagnostic[]>();
function publishDiagnostics(uri: string) {
  const snapshot = get(uri);
  const tests = [...testResults.values()]
    .filter((result) => !result.stale)
    .flatMap((result) => result.diagnostics.get(uri) ?? []);
  publish(
    connection.sendDiagnostics({
      uri,
      version: documents.get(uri)?.version,
      diagnostics: [
        ...(snapshot?.diagnostics.get(analysisUri(snapshot, uri)) ?? []),
        ...tests,
        ...(configDiagnostics.get(uri) ?? []),
      ],
    }),
  );
}
function sourceLineLength(uri: string, line: number): number {
  return (
    documents
      .get(uri)
      ?.getText({
        start: { line, character: 0 },
        end: { line: line + 1, character: 0 },
      })
      .replace(/\r?\n$|\r$/, "").length ?? 1
  );
}
const queuedDiagnostics = new Set<string>();
let diagnosticTimer: NodeJS.Timeout | undefined;
function queueDiagnostics(uri: string) {
  queuedDiagnostics.add(uri);
  if (!diagnosticTimer)
    diagnosticTimer = setTimeout(() => {
      diagnosticTimer = undefined;
      const uris = [...queuedDiagnostics];
      queuedDiagnostics.clear();
      for (const source of uris) publishDiagnostics(source);
    }, 20);
}
const runner = new ToolRunner(path.join(bundle, "vendor", "choicescript"), (event) => {
  publish(connection.sendNotification("choicescript/jobEvent", event));
  const previous = testResults.get(event.projectId);
  if (event.kind === "started") {
    testResults.set(event.projectId, { jobId: event.jobId, stale: !!event.stale, diagnostics: new Map() });
    for (const uri of previous?.diagnostics.keys() ?? []) publishDiagnostics(uri);
    return;
  }
  if (!previous || previous.jobId !== event.jobId) return;
  if (
    event.kind === "stale" ||
    event.stale ||
    (event.kind === "completed" && (event.exitCode === 0 || event.exitCode === 130))
  ) {
    const uris = [...previous.diagnostics.keys()];
    previous.stale ||= event.kind === "stale" || !!event.stale;
    for (const uri of uris) {
      const warnings =
        event.kind === "completed" && event.exitCode === 0 && !previous.stale && !event.stale
          ? previous.diagnostics.get(uri)!.filter((diagnostic) => diagnostic.severity === 2)
          : [];
      if (warnings.length) previous.diagnostics.set(uri, warnings);
      else previous.diagnostics.delete(uri);
      publishDiagnostics(uri);
    }
  }
  if (event.kind === "diagnostic" && event.uri && !previous.stale) {
    const diagnostics = previous.diagnostics.get(event.uri) ?? [];
    diagnostics.push({
      severity: event.severity ?? 1,
      source: "ChoiceScript test",
      message: event.message ?? "Test failure",
      range: {
        start: { line: event.line ?? 0, character: 0 },
        end: {
          line: event.line ?? 0,
          character: Math.max(1, sourceLineLength(event.uri, event.line ?? 0)),
        },
      },
    });
    previous.diagnostics.set(event.uri, diagnostics);
    queueDiagnostics(event.uri);
  }
});
function publish(promise: Promise<unknown>) {
  void promise.catch((error) => {
    if (!disposed) console.error("Could not send language-server update:", error);
  });
}
function analysisUri(a: Analysis | undefined, uri: string) {
  if (!a || a.documents.has(uri)) return uri;
  return [...a.documents.keys()].find((candidate) => sameFileUri(candidate, uri)) ?? uri;
}
function get(uri: string) {
  const id = projectFor(projects, uri)?.id ?? uri;
  if (analysisVersions.get(id) !== revision) return undefined;
  const a = analyses.get(id),
    open = documents.get(uri);
  return open && a?.documents.get(analysisUri(a, uri))?.version !== open.version ? undefined : a;
}
let discoveryRevision = 0;
async function refreshProjects() {
  const discovery = ++discoveryRevision;
  try {
    const errors = new Map<string, Diagnostic[]>();
    const found = await discoverProjects([...roots], (uri, message) =>
      errors.set(uri, [
        {
          severity: 1,
          source: "Bifoil ChoiceScript",
          message,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ]),
    );
    if (discovery !== discoveryRevision || disposed) return;
    const oldConfigUris = [...configDiagnostics.keys()];
    configDiagnostics.clear();
    for (const [uri, diagnostics] of errors) configDiagnostics.set(uri, diagnostics);
    for (const uri of new Set([...oldConfigUris, ...errors.keys()])) publishDiagnostics(uri);
    const removed = projects.filter((project) => !found.some((candidate) => candidate.id === project.id));
    projects = found;
    for (const pending of pendingStarts.values())
      if (removed.some((project) => project.id === pending.projectId)) pending.cancelled = true;
    await Promise.all(removed.map((project) => runner.stopProject(project.id)));
    for (const project of removed) testResults.delete(project.id);
    await connection.sendNotification("choicescript/projectsChanged", projects);
  } catch (error) {
    connection.window.showErrorMessage(String(error));
  }
}
function schedule() {
  revision++;
  for (const w of workers) void w.terminate();
  workers.clear();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void analyze(revision), 100);
}
async function analyze(version: number) {
  const open = snapshots();
  const jobs: { id: string; documents: BufferSnapshot[] }[] = [];
  try {
    for (const project of projects)
      jobs.push({
        id: project.id,
        documents: await readProject(project, open),
      });
    for (const doc of open)
      if (!projectFor(projects, doc.uri) && documents.get(doc.uri)?.languageId === "choicescript")
        jobs.push({ id: doc.uri, documents: [doc] });
    if (version !== revision || disposed) return;
    for (const [id, previous] of analyses)
      if (!jobs.some((job) => job.id === id)) {
        for (const uri of previous.documents.keys()) await connection.sendDiagnostics({ uri, diagnostics: [] });
        analyses.delete(id);
        analysisVersions.delete(id);
      }
    await Promise.all(
      jobs.map(
        (job) =>
          new Promise<void>((resolve) => {
            const worker = new Worker(path.join(bundle, "analysis-worker.cjs"));
            workers.add(worker);
            worker.once("message", ({ analysis, error }: { analysis?: Analysis; error?: string }) => {
              if (version === revision && !disposed) {
                if (error) connection.console.error(error);
                if (analysis) {
                  for (const oldUri of analyses.get(job.id)?.documents.keys() ?? [])
                    if (!analysis.documents.has(oldUri))
                      publish(
                        connection.sendDiagnostics({
                          uri: oldUri,
                          diagnostics: [],
                        }),
                      );
                  analyses.set(job.id, analysis);
                  analysisVersions.set(job.id, version);
                  for (const uri of analysis.diagnostics.keys()) publishDiagnostics(uri);
                  if (analysis.truncated)
                    connection.window.showWarningMessage(
                      "ChoiceScript analysis reached its work limit; some results are incomplete.",
                    );
                }
              }
              void worker.terminate();
              workers.delete(worker);
              resolve();
            });
            worker.once("error", (error) => {
              connection.console.error(error.message);
              workers.delete(worker);
              resolve();
            });
            worker.once("exit", () => {
              workers.delete(worker);
              resolve();
            });
            worker.postMessage({
              documents: job.documents,
              options: { quoteWarnings },
            });
          }),
      ),
    );
    if (version === revision && !disposed) connection.languages.semanticTokens.refresh();
  } catch (error) {
    connection.console.error(String(error));
  }
}
connection.onInitialize((params) => {
  quoteWarnings = params.initializationOptions?.quoteWarnings ?? true;
  roots = (params.workspaceFolders ?? []).map((f) => f.uri);
  if (!roots.length) {
    // Read the legacy wire shape for clients that omit workspaceFolders.
    const legacyParams: { rootUri?: string | null } = params;
    if (legacyParams.rootUri) roots = [legacyParams.rootUri];
  }
  return {
    serverInfo: { name: "Bifoil ChoiceScript (Unofficial)", version: "0.1.0" },
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ["*", "{"] },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      semanticTokensProvider: {
        legend: { tokenTypes, tokenModifiers },
        full: true,
      },
      executeCommandProvider: { commands },
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
  };
});
connection.onInitialized(async () => {
  await refreshProjects();
  schedule();
  try {
    await connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [{ globPattern: "**/*" }],
    });
  } catch {}
});
const bufferTexts = new Map<string, string>();
const pendingDiskChecks = new Set<Promise<void>>();
function checkDiskDifference(document: TextDocument) {
  const project = projectFor(projects, document.uri);
  if (!project || !document.uri.startsWith("file:")) return;
  const text = document.getText();
  const check = readFile(fileURLToPath(document.uri), "utf8")
    .then((disk) => {
      if (disk !== text) runner.markStale(project.id);
    })
    .catch(() => runner.markStale(project.id));
  pendingDiskChecks.add(check);
  void check.finally(() => pendingDiskChecks.delete(check));
}
documents.onDidChangeContent(({ document }) => {
  const previous = bufferTexts.get(document.uri);
  const text = document.getText();
  bufferTexts.set(document.uri, text);
  if (previous === undefined) checkDiskDifference(document);
  else if (previous !== text) {
    const project = projectFor(projects, document.uri);
    if (project) runner.markStale(project.id);
  }
  schedule();
});
documents.onDidClose(({ document }) => {
  bufferTexts.delete(document.uri);
  checkDiskDifference(document);
  schedule();
});
connection.onDidChangeWatchedFiles(async ({ changes }) => {
  const changedSources: string[] = [];
  let discoveryChanged = false;
  for (const change of changes) {
    if (!change.uri.startsWith("file:")) continue;
    const affected = affectedProjects(projects, change.uri);
    for (const project of affected) runner.markStale(project.id);
    const file = fileURLToPath(change.uri),
      name = path.basename(file).toLowerCase();
    if (affected.length > 0 && /\.txt$/i.test(file)) {
      changedSources.push(change.uri);
    }
    discoveryChanged ||=
      (name === "startup.txt" && change.type !== 2) ||
      name === "choicescript.json" ||
      (change.type !== 2 && projects.some((project) => contains(file, project.sceneDir)));
  }
  // Owned logs/build output and asset-only events must not cancel language analysis.
  if (changedSources.length) schedule();
  if (discoveryChanged) {
    await refreshProjects();
    schedule();
  }
});
connection.onNotification("choicescript/assetChanged", ({ uri }: { uri: string }) => {
  for (const project of affectedProjects(projects, uri)) runner.markStale(project.id);
});
connection.onNotification(
  "workspace/didChangeWorkspaceFolders",
  async ({ event }: { event: { removed: { uri: string }[]; added: { uri: string }[] } }) => {
    roots = roots.filter((r) => !event.removed.some((f) => f.uri === r));
    roots.push(...event.added.map((f) => f.uri));
    schedule();
    await refreshProjects();
    schedule();
  },
);
connection.onDidChangeConfiguration((e) => {
  quoteWarnings = e.settings?.bifoil?.choicescript?.quoteWarnings ?? true;
  schedule();
});
connection.onCompletion((p) => {
  const a = get(p.textDocument.uri);
  return a ? completions(a, analysisUri(a, p.textDocument.uri), p.position) : [];
});
connection.onHover((p) => {
  const a = get(p.textDocument.uri);
  return a ? hover(a, analysisUri(a, p.textDocument.uri), p.position) : null;
});
connection.onDefinition((p) => {
  const a = get(p.textDocument.uri);
  return a ? definition(a, analysisUri(a, p.textDocument.uri), p.position) : null;
});
connection.onReferences((p) => {
  const a = get(p.textDocument.uri);
  return a ? references(a, analysisUri(a, p.textDocument.uri), p.position, p.context.includeDeclaration) : [];
});
connection.onPrepareRename((p) => {
  const a = get(p.textDocument.uri);
  return a ? prepareRename(a, analysisUri(a, p.textDocument.uri), p.position) : null;
});
connection.onRenameRequest((p) => {
  const a = get(p.textDocument.uri);
  try {
    return a ? rename(a, analysisUri(a, p.textDocument.uri), p.position, p.newName) : null;
  } catch (e) {
    throw new ResponseError(ErrorCodes.InvalidParams, String(e));
  }
});
connection.onDocumentSymbol((p) => {
  const a = get(p.textDocument.uri);
  return a ? documentSymbols(a, analysisUri(a, p.textDocument.uri)) : [];
});
connection.onWorkspaceSymbol((p) =>
  [...analyses.entries()]
    .filter(([id]) => analysisVersions.get(id) === revision)
    .flatMap(([, a]) =>
      [...a.symbols.values()]
        .filter((s) => s.name.toLowerCase().includes(p.query.toLowerCase()))
        .map((s) => ({
          name: s.name,
          kind: s.kind === "label" ? 12 : 13,
          location: { uri: s.uri, range: s.range },
        })),
    ),
);
connection.onFoldingRanges((p) => {
  const a = get(p.textDocument.uri);
  return a ? folding(a, analysisUri(a, p.textDocument.uri)) : [];
});
connection.onSelectionRanges((p) => {
  const a = get(p.textDocument.uri);
  return a ? selections(a, analysisUri(a, p.textDocument.uri), p.positions) : [];
});
connection.languages.semanticTokens.on((p) => {
  const a = get(p.textDocument.uri);
  return a ? encodeTokens(a, analysisUri(a, p.textDocument.uri)) : { data: [] };
});
connection.onRequest("choicescript/projects", () => projects);
connection.onRequest("choicescript/wordCount", (p: { uri: string }) => {
  const a = get(p.uri);
  return a?.wordCounts.get(analysisUri(a, p.uri)) ?? 0;
});
const pendingStarts = new Map<string, { projectId: string; cancelled: boolean }>();
async function execute(request: JobRequest) {
  if (!request || request.protocolVersion !== PROTOCOL_VERSION)
    throw new ResponseError(ErrorCodes.InvalidParams, `Expected protocolVersion ${PROTOCOL_VERSION}.`);
  if (!request.trusted && request.operation !== "stop")
    throw new ResponseError(ErrorCodes.InvalidRequest, "Trust the workspace before running game code.");
  if (request.operation === "createProject") {
    if (!request.destination) throw new Error("Choose a destination.");
    const result = await runner.createProject(request.destination);
    roots.push(request.destination);
    await refreshProjects();
    schedule();
    return result;
  }
  if (request.operation === "stop") {
    for (const [id, pending] of pendingStarts)
      if ((!request.jobId || id === request.jobId) && (!request.projectId || pending.projectId === request.projectId))
        pending.cancelled = true;
    return runner.stopProject(request.projectId, request.jobId);
  }
  const project = projects.find((p) => p.id === request.projectId);
  if (!project) throw new Error("Select a detected ChoiceScript project.");
  // Finish earlier open/close comparisons before a new run captures its snapshot.
  const id = request.jobId ?? randomUUID();
  if (pendingStarts.has(id)) throw new Error("Job ID is already in use.");
  const pending = { projectId: project.id, cancelled: false };
  pendingStarts.set(id, pending);
  try {
    await Promise.all(pendingDiskChecks);
    if (!pending.cancelled && !disposed) return await runner.start({ ...request, jobId: id }, project, snapshots());
  } catch (error) {
    if (!pending.cancelled && !disposed) throw error;
  } finally {
    pendingStarts.delete(id);
  }
  // Cancellation can arrive during the disk checks or while the runner prepares the snapshot.
  throw new ResponseError(LSPErrorCodes.RequestCancelled, "Operation cancelled.");
}
connection.onExecuteCommand((p) => execute(p.arguments?.[0]));
connection.onRequest("choicescript/job", execute);
async function dispose() {
  disposed = true;
  if (diagnosticTimer) clearTimeout(diagnosticTimer);
  queuedDiagnostics.clear();
  if (timer) clearTimeout(timer);
  for (const w of workers) void w.terminate();
  await runner.dispose();
}
connection.onShutdown(dispose);
connection.onExit(() => void dispose());
process.on("SIGTERM", () => void dispose().then(() => process.exit(0)));
documents.listen(connection);
connection.listen();
