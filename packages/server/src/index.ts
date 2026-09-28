import {
  createConnection,
  DidChangeWatchedFilesNotification,
  ErrorCodes,
  ProposedFeatures,
  ResponseError,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
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
} from "@branchlight/core";
import { discoverProjects, projectFor, readProject, sameFileUri, ToolRunner } from "@branchlight/tooling";
import { type BufferSnapshot, commands, type JobRequest, type Project, PROTOCOL_VERSION } from "@branchlight/protocol";

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
const runner = new ToolRunner(path.join(bundle, "vendor", "choicescript"), (event) => {
  publish(connection.sendNotification("choicescript/jobEvent", event));
  if (event.kind === "diagnostic" && event.uri)
    publish(
      connection.sendDiagnostics({
        uri: event.uri,
        diagnostics: [
          ...(get(event.uri)?.diagnostics.get(event.uri) ?? []),
          {
            severity: 1,
            source: "ChoiceScript test",
            message: event.message ?? "Test failure",
            range: {
              start: { line: event.line ?? 0, character: 0 },
              end: { line: event.line ?? 0, character: 1000 },
            },
          },
        ],
      }),
    );
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
    const found = await discoverProjects([...roots]);
    if (discovery !== discoveryRevision || disposed) return;
    projects = found;
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
                  for (const [uri, diagnostics] of analysis.diagnostics)
                    publish(
                      connection.sendDiagnostics({
                        uri,
                        version: documents.get(uri)?.version,
                        diagnostics,
                      }),
                    );
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
    serverInfo: { name: "Branchlight (Unofficial)", version: "0.1.0" },
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
      watchers: [{ globPattern: "**/*.txt" }, { globPattern: "**/choicescript.json" }],
    });
  } catch {}
});
documents.onDidChangeContent((e) => {
  const project = projectFor(projects, e.document.uri);
  if (project) runner.markStale(project.id);
  schedule();
});
documents.onDidClose(() => schedule());
connection.onDidChangeWatchedFiles(async () => {
  schedule();
  await refreshProjects();
  for (const project of projects) runner.markStale(project.id);
  schedule();
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
  quoteWarnings = e.settings?.branchlight?.quoteWarnings ?? true;
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
  return a ? references(a, analysisUri(a, p.textDocument.uri), p.position) : [];
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
  const project = projects.find((p) => p.id === request.projectId);
  if (!project) throw new Error("Select a detected ChoiceScript project.");
  return runner.start(request, project, await readProject(project, snapshots()));
}
connection.onExecuteCommand((p) => execute(p.arguments?.[0]));
connection.onRequest("choicescript/job", execute);
async function dispose() {
  disposed = true;
  if (timer) clearTimeout(timer);
  for (const w of workers) void w.terminate();
  await runner.dispose();
}
connection.onShutdown(dispose);
connection.onExit(() => void dispose());
process.on("SIGTERM", () => void dispose().then(() => process.exit(0)));
documents.listen(connection);
connection.listen();
