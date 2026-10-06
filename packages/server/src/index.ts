import {
  type CancellationToken,
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
import { Worker } from "node:worker_threads";
import {
  type AnalysisSnapshot,
  mergeSnapshot,
  requestAnalysis,
  snapshotFolding,
  snapshotTokens,
  updatePlainProse,
} from "./snapshots.js";
import path from "node:path";
import { type IndexedSource, SceneIndex, SummaryCache } from "./scene-index.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  completions,
  definition,
  documentSymbols,
  hover,
  type Position,
  prepareRename,
  references,
  rename,
  selections,
  tokenModifiers,
  tokenTypes,
} from "@bifoil/choicescript-core";
import {
  affectedProjects,
  contains,
  discoverProjects,
  projectFor,
  sameFileUri,
  ToolRunner,
} from "@bifoil/choicescript-tooling";
import {
  analysisWorkerLimits,
  type BufferSnapshot,
  commands,
  type IndexStatus,
  interactionDeadlineMs,
  type JobRequest,
  type Project,
  PROTOCOL_VERSION,
} from "@bifoil/choicescript-protocol";

const connection = createConnection(ProposedFeatures.all),
  documents = new TextDocuments(TextDocument);
const arg = process.argv.indexOf("--bundle-root"),
  bundle = arg >= 0 ? path.resolve(process.argv[arg + 1]) : __dirname;
let roots: string[] = [],
  projects: Project[] = [],
  quoteWarnings = true,
  preferredUri: string | undefined,
  revision = 0,
  timer: NodeJS.Timeout | undefined,
  disposed = false;

/**
 * Scheduling state has two freshness dimensions: the global revision and each open
 * document's version. Unaffected projects can advance to a new revision without rebuilding;
 * dirty projects must publish a matching new snapshot before requests use them.
 */
const sceneIndexes = new Map<string, SceneIndex>();
const summaryCache = new SummaryCache();
const analysisVersions = new Map<string, number>();
const dirtyProjects = new Set<string>();
const analysisUpdates = new Set<() => void>();
const analyses = new Map<string, AnalysisSnapshot>(),
  workers = new Set<Worker>();
const stoppingWorkers = new Set<Promise<unknown>>();
const workerStops = new Map<Worker, Promise<number>>();
let activeAnalysis: { id: string; worker: Worker; busy: boolean } | undefined;

/**
 * Coalesce repeated termination requests and retain their promises until exit.
 * A replacement analysis must await stoppingWorkers so retired and new heaps do not overlap.
 */
function stopWorker(worker: Worker) {
  const previous = workerStops.get(worker);

  if (previous) return previous;

  const stopped = worker.terminate();
  workerStops.set(worker, stopped);
  stoppingWorkers.add(stopped);
  void stopped.finally(() => {
    workers.delete(worker);
    workerStops.delete(worker);
    stoppingWorkers.delete(stopped);
  });

  return stopped;
}

const snapshots = (): BufferSnapshot[] =>
  documents
    .all()
    .filter((d) => d.uri.startsWith("file:"))
    .map((d) => ({ uri: d.uri, text: d.getText(), version: d.version }));

const testResults = new Map<string, { jobId: string; stale: boolean; diagnostics: Map<string, Diagnostic[]> }>();
const configDiagnostics = new Map<string, Diagnostic[]>();

/**
 * Combine only an accepted language snapshot with nonstale latest-job and config diagnostics.
 * Attach the open document version so clients can reject messages overtaken by edits.
 */
function publishDiagnostics(uri: string) {
  const snapshot = currentSnapshot(uri);
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

/**
 * Match URI spelling to the snapshot's key, including differences in Windows path capitalization.
 * Preserve the source identity used elsewhere.
 */
function analysisUri(a: { documents: ReadonlyMap<string, unknown> } | undefined, uri: string) {
  if (!a || a.documents.has(uri)) return uri;

  return [...a.documents.keys()].find((candidate) => sameFileUri(candidate, uri)) ?? uri;
}

/**
 * Return only the accepted global revision and exact open-buffer version; callers separately decide completeness.
 */
function currentSnapshot(uri: string) {
  const id = projectFor(projects, uri)?.id ?? uri;

  if (analysisVersions.get(id) !== revision) return undefined;

  const snapshot = analyses.get(id),
    open = documents.get(uri);

  return open && snapshot?.documents.get(analysisUri(snapshot, uri))?.version !== open.version ? undefined : snapshot;
}

function notifyAnalysis() {
  for (const update of [...analysisUpdates]) update();
}

/**
 * Prefer a full current foreground scene, scheduling promotion from a compact scene.
 * Wait briefly for analysis while watching document changes and LSP cancellation.
 * A deadline yields ContentModified, not a successful empty/stale latency result.
 * Every settlement must remove its update listener, timeout, and cancellation subscription.
 */
async function snapshotForRequest(uri: string, token?: CancellationToken): Promise<AnalysisSnapshot | undefined> {
  const ready = currentSnapshot(uri);

  if (ready && !ready.features.get(analysisUri(ready, uri))?.compact) return ready;

  if (ready) {
    preferredUri = uri;
    schedule([uri]);
  }

  const id = projectFor(projects, uri)?.id ?? uri;

  if (!dirtyProjects.has(id) || disposed) return undefined;

  const preferredId = preferredUri ? (projectFor(projects, preferredUri)?.id ?? preferredUri) : undefined;

  if (preferredId !== id && activeAnalysis?.id !== id) {
    preferredUri = uri;
    schedule([uri]);
  }

  const version = documents.get(uri)?.version;

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    let cancellation: { dispose(): void } | undefined;

    const finish = (snapshot?: AnalysisSnapshot, error?: ResponseError) => {
      if (timeout) clearTimeout(timeout);

      cancellation?.dispose();
      analysisUpdates.delete(check);
      if (error) reject(error);
      else resolve(snapshot);
    };

    const check = () => {
      if (token?.isCancellationRequested || disposed)
        finish(undefined, new ResponseError(LSPErrorCodes.RequestCancelled, "Request cancelled."));
      else if (documents.get(uri)?.version !== version)
        finish(undefined, new ResponseError(LSPErrorCodes.ContentModified, "Document changed during this request."));
      else {
        const snapshot = currentSnapshot(uri);

        if (snapshot) finish(snapshot);
      }
    };

    analysisUpdates.add(check);
    cancellation = token?.onCancellationRequested(check);
    // Reserve time for decoding the small request index and transmitting its result.
    timeout = setTimeout(
      () =>
        finish(
          undefined,
          new ResponseError(
            LSPErrorCodes.ContentModified,
            "Current analysis is still pending; retry this interaction.",
          ),
        ),
      interactionDeadlineMs - 50,
    );
    check();
  });
}

/**
 * Decode a feature-query facade; whole-project references require indexed context rather than partial results.
 */
async function get(uri: string, positions: Position[] = [], withReferences = false, token?: CancellationToken) {
  const snapshot = await snapshotForRequest(uri, token);

  if (withReferences && snapshot?.incomplete)
    throw new ResponseError(
      LSPErrorCodes.ContentModified,
      "Project indexing is still pending; retry navigation or rename when it finishes.",
    );

  return snapshot ? requestAnalysis(snapshot, analysisUri(snapshot, uri), positions, withReferences) : undefined;
}

let discoveryRevision = 0;

/**
 * Replace discovery atomically for the latest discovery revision.
 * Publish configuration errors and cancel removed projects' jobs; an older async scan
 * must never replace the project list found by a newer workspace change.
 */
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

/**
 * Invalidate affected games, carry unaffected snapshots into the new revision, and debounce.
 * Busy workers are retired; their results must still pass revision checks before publication.
 */
function schedule(changedUris?: string[]) {
  revision++;

  if (changedUris) {
    for (const uri of changedUris) dirtyProjects.add(projectFor(projects, uri)?.id ?? uri);
  } else {
    for (const project of projects) dirtyProjects.add(project.id);
    for (const doc of documents.all())
      if (!projectFor(projects, doc.uri) && doc.languageId === "choicescript") dirtyProjects.add(doc.uri);
  }

  for (const id of analyses.keys()) if (!dirtyProjects.has(id)) analysisVersions.set(id, revision);

  notifyAnalysis();
  if (activeAnalysis?.busy) void stopWorker(activeAnalysis.worker);
  if (timer) clearTimeout(timer);

  timer = setTimeout(() => void analyze(revision), 25);
}

/**
 * Start one analysis worker with worker-specific heap limits; parent V8 flags must not override those resource limits.
 */
function createWorker(id: string) {
  const worker = new Worker(path.join(bundle, "analysis-worker.cjs"), {
    resourceLimits: analysisWorkerLimits,
    execArgv: process.execArgv.filter((arg) => !/^--max-(?:old-space|semi-space)-size=/.test(arg)),
  });
  activeAnalysis = { id, worker, busy: true };
  workers.add(worker);
  worker.on("error", (error) => {
    connection.console.error(error.message);
    void stopWorker(worker);
  });

  worker.once("exit", () => {
    if (activeAnalysis?.worker === worker) activeAnalysis = undefined;

    workers.delete(worker);
  });

  return worker;
}

/**
 * Build missing closed-scene projections for one generation. Per-file errors are recorded;
 * late messages are ignored after invalidation. Fatal worker failures are distinct from
 * per-file failures, so cached/failed counts alone are not a complete health signal.
 */
async function indexScenes(index: SceneIndex, version: number) {
  const sources = (await index.inventory()).filter(
    (source) => !index.cached.has(source.uri) && !index.failed.has(source.uri),
  );

  if (!sources.length || version !== revision || disposed) return;

  const directory = await index.cacheDirectory(),
    generation = index.generation;

  if (version !== revision || disposed) return;
  if (activeAnalysis) await stopWorker(activeAnalysis.worker);
  if (version !== revision || disposed) return;

  await new Promise<void>((resolve) => {
    const worker = createWorker(index.project.id);
    worker.on("message", (message) => {
      if (index.generation !== generation || disposed) return;

      if (message.indexed) {
        const { uri, cache, data } = message.indexed;
        index.cached.set(uri, cache);
        index.stamps.set(uri, ++index.nextStamp);
        summaryCache.set(cache, data);
      }

      if (message.indexError) {
        index.failed.set(message.indexError.uri, message.indexError.error);
        connection.console.error(message.indexError.error);
      }

      if (message.done || message.error) {
        if (message.error) connection.console.error(message.error);

        void stopWorker(worker).then(() => resolve());
      }
    });

    worker.once("error", (error) => {
      connection.console.error(error.message);
      void stopWorker(worker).then(() => resolve());
    });
    worker.once("exit", () => resolve());
    worker.postMessage({ mode: "index", sources, directory });
  });
  if (version === revision && !disposed && index.generation === generation) schedule([index.project.id]);
}

/**
 * Serialize analysis after retired workers exit, prioritizing the foreground project.
 * Accept only this scheduled revision, merge feature deltas, then publish diagnostics
 * and token refreshes. Background indexing yields to newly scheduled foreground work.
 */
async function analyze(version: number) {
  await Promise.all([...stoppingWorkers]);
  if (version !== revision || disposed) return;

  const open = snapshots();
  type Job = { id: string; documents: BufferSnapshot[]; sources: IndexedSource[]; index?: SceneIndex };

  const jobs: Job[] = [];

  try {
    const preferredId = preferredUri ? (projectFor(projects, preferredUri)?.id ?? preferredUri) : undefined;
    const pending = projects.filter((project) => dirtyProjects.has(project.id));
    pending.sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId));

    for (const project of pending) {
      let index = sceneIndexes.get(project.id);

      if (!index) {
        index = new SceneIndex(project);
        sceneIndexes.set(project.id, index);
      }

      const inventory = await index.inventory();
      const buffers = open.filter((document) => projectFor([project], document.uri));
      const sources = inventory.map((source) => {
        const cache = index!.cached.get(source.uri);
        return {
          ...source,
          cache,
          stamp: index!.stamps.get(source.uri),
          data: cache ? summaryCache.get(cache) : undefined,
          full:
            path.basename(source.file).toLowerCase() === "startup.txt" ||
            (!!preferredUri && sameFileUri(source.uri, preferredUri)),
        };
      });
      jobs.push({ id: project.id, documents: buffers, sources, index });
    }

    for (const doc of open)
      if (
        dirtyProjects.has(doc.uri) &&
        !projectFor(projects, doc.uri) &&
        documents.get(doc.uri)?.languageId === "choicescript"
      )
        jobs.push({ id: doc.uri, documents: [doc], sources: [] });

    if (version !== revision || disposed) return;

    jobs.sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId));

    const activeIds = new Set([
      ...projects.map((project) => project.id),
      ...open
        .filter((doc) => !projectFor(projects, doc.uri) && documents.get(doc.uri)?.languageId === "choicescript")
        .map((doc) => doc.uri),
    ]);

    for (const id of dirtyProjects) if (!activeIds.has(id)) dirtyProjects.delete(id);

    for (const [id, previous] of analyses)
      if (!activeIds.has(id)) {
        for (const uri of previous.documents.keys()) publish(connection.sendDiagnostics({ uri, diagnostics: [] }));

        analyses.delete(id);
        analysisVersions.delete(id);

        const index = sceneIndexes.get(id);
        sceneIndexes.delete(id);
        if (index) await index.dispose();
      }

    for (const job of jobs) {
      if (version !== revision || disposed) return;
      if (activeAnalysis && activeAnalysis.id !== job.id) await stopWorker(activeAnalysis.worker);
      if (version !== revision || disposed) return;

      await new Promise<void>((resolve) => {
        const worker = activeAnalysis?.id === job.id ? activeAnalysis.worker : createWorker(job.id);
        activeAnalysis!.busy = true;
        worker.once("message", async ({ snapshot, error }: { snapshot?: AnalysisSnapshot; error?: string }) => {
          try {
            if (version !== revision || disposed) {
              await stopWorker(worker);
              return;
            }

            if (activeAnalysis?.worker === worker) activeAnalysis.busy = false;
            if (error) connection.console.error(error);

            if (snapshot) {
              const previous = analyses.get(job.id);
              snapshot = mergeSnapshot(previous, snapshot);

              for (const oldUri of analyses.get(job.id)?.documents.keys() ?? [])
                if (!snapshot.documents.has(oldUri))
                  publish(connection.sendDiagnostics({ uri: oldUri, diagnostics: [] }));

              analyses.set(job.id, snapshot);
              analysisVersions.set(job.id, version);
              dirtyProjects.delete(job.id);
              notifyAnalysis();

              for (const [uri, current] of snapshot.diagnostics) {
                const old = previous?.diagnostics.get(uri);
                const unchanged =
                  old &&
                  previous?.documents.get(uri)?.version === snapshot.documents.get(uri)?.version &&
                  ((old.length === 0 && current.length === 0) || JSON.stringify(old) === JSON.stringify(current));

                if (!unchanged) publishDiagnostics(uri);
              }

              connection.languages.semanticTokens.refresh();

              if (snapshot.truncated)
                connection.window.showWarningMessage(
                  "ChoiceScript analysis reached its work limit; some results are incomplete.",
                );
            }
          } catch (error) {
            connection.console.error(String(error));
            await stopWorker(worker);
          } finally {
            resolve();
          }
        });

        const failed = (error: Error) => {
          connection.console.error(error.message);
          void stopWorker(worker).then(() => resolve());
        };

        const exited = () => resolve();

        worker.once("error", failed);
        worker.once("exit", exited);
        // Reused workers must not accumulate handlers from completed generations.
        worker.once("message", () => {
          worker.off("error", failed);
          worker.off("exit", exited);
        });
        worker.postMessage({ documents: job.documents, sources: job.sources, options: { quoteWarnings } });
      });
    }

    // Only one worker exists at a time; foreground edits interrupt background indexing.
    for (const index of sceneIndexes.values()) {
      if (version !== revision || disposed) return;

      await indexScenes(index, version);
    }
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
const bufferVersions = new Map<string, number>();
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
  preferredUri = document.uri;

  const previous = bufferTexts.get(document.uri);
  const previousVersion = bufferVersions.get(document.uri);
  const text = document.getText();
  bufferTexts.set(document.uri, text);
  bufferVersions.set(document.uri, document.version);

  if (previous === undefined) checkDiskDifference(document);
  else if (previous !== text) {
    const project = projectFor(projects, document.uri);

    if (project) runner.markStale(project.id);
  }

  const id = projectFor(projects, document.uri)?.id ?? document.uri,
    snapshot = analyses.get(id);

  if (
    previous !== undefined &&
    previousVersion !== undefined &&
    snapshot &&
    analysisVersions.get(id) === revision &&
    !dirtyProjects.has(id)
  ) {
    const updated = updatePlainProse(
      snapshot,
      analysisUri(snapshot, document.uri),
      previous,
      text,
      previousVersion,
      document.version,
    );

    if (updated) {
      analyses.set(id, updated);
      publishDiagnostics(document.uri);
      notifyAnalysis();
      connection.languages.semanticTokens.refresh();

      return;
    }
  }

  schedule([document.uri]);
});

documents.onDidClose(({ document }) => {
  bufferTexts.delete(document.uri);
  bufferVersions.delete(document.uri);
  checkDiskDifference(document);
  schedule([document.uri]);
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
      for (const project of affected) sceneIndexes.get(project.id)?.invalidate(change.uri);
    }

    discoveryChanged ||=
      (name === "startup.txt" && change.type !== 2) ||
      name === "choicescript.json" ||
      (change.type !== 2 && projects.some((project) => contains(file, project.sceneDir)));
  }

  // Owned logs/build output and asset-only events must not cancel language analysis.
  if (changedSources.length) schedule(changedSources);

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

connection.onCompletion(async (p, token) => {
  const a = await get(p.textDocument.uri, [p.position], false, token);
  return a ? completions(a, analysisUri(a, p.textDocument.uri), p.position) : [];
});

connection.onHover(async (p, token) => {
  const a = await get(p.textDocument.uri, [p.position], false, token);
  return a ? hover(a, analysisUri(a, p.textDocument.uri), p.position) : null;
});

connection.onDefinition(async (p, token) => {
  const a = await get(p.textDocument.uri, [p.position], false, token);
  return a ? definition(a, analysisUri(a, p.textDocument.uri), p.position) : null;
});

connection.onReferences(async (p, token) => {
  const a = await get(p.textDocument.uri, [p.position], true, token);
  return a ? references(a, analysisUri(a, p.textDocument.uri), p.position, p.context.includeDeclaration) : [];
});

connection.onPrepareRename(async (p, token) => {
  const a = await get(p.textDocument.uri, [p.position], false, token);
  return a ? prepareRename(a, analysisUri(a, p.textDocument.uri), p.position) : null;
});

connection.onRenameRequest(async (p, token) => {
  const a = await get(p.textDocument.uri, [p.position], true, token);

  try {
    return a ? rename(a, analysisUri(a, p.textDocument.uri), p.position, p.newName) : null;
  } catch (e) {
    throw new ResponseError(ErrorCodes.InvalidParams, String(e));
  }
});

connection.onDocumentSymbol(async (p, token) => {
  const a = await get(p.textDocument.uri, [], false, token);
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

connection.onFoldingRanges(async (p, token) => {
  const snapshot = await snapshotForRequest(p.textDocument.uri, token);
  return snapshot ? snapshotFolding(snapshot, analysisUri(snapshot, p.textDocument.uri)) : [];
});

connection.onSelectionRanges(async (p, token) => {
  const a = await get(p.textDocument.uri, p.positions, false, token);
  return a ? selections(a, analysisUri(a, p.textDocument.uri), p.positions) : [];
});

connection.languages.semanticTokens.on(async (p, token) => {
  const snapshot = await snapshotForRequest(p.textDocument.uri, token);
  return snapshot ? snapshotTokens(snapshot, analysisUri(snapshot, p.textDocument.uri)) : { data: [] };
});
connection.onRequest("choicescript/projects", () => projects);
connection.onRequest("choicescript/indexStatus", (): IndexStatus[] =>
  projects.map((project) => {
    const index = sceneIndexes.get(project.id),
      snapshot = analyses.get(project.id);
    return {
      projectId: project.id,
      scenes: index?.sources?.length ?? 0,
      indexed: index?.cached.size ?? 0,
      words: [...(snapshot?.wordCounts.values() ?? [])].reduce((total, words) => total + words, 0),
      failures: index?.failed.size ?? 0,
      complete: !!snapshot && !snapshot.incomplete && !snapshot.truncated && !dirtyProjects.has(project.id),
      limited: !!snapshot?.truncated,
    };
  }),
);

connection.onRequest("choicescript/wordCount", async (p: { uri: string }, token) => {
  const snapshot = await snapshotForRequest(p.uri, token);
  return snapshot?.wordCounts.get(analysisUri(snapshot, p.uri)) ?? 0;
});

/**
 * Starts can be cancelled before disk/buffer comparisons finish, before ToolRunner owns a job.
 * Track the caller UUID here as well as in the runner so an early stop is not lost.
 */
const pendingStarts = new Map<string, { projectId: string; cancelled: boolean }>();

/**
 * Validate custom protocol/trust, resolve a project, and coordinate job starts/stops.
 * The wire response acknowledges test/export launch; completion is a separate event.
 * Stop remains permitted without trust and without rediscovering a deleted source path.
 */
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

/**
 * Retire the server session: stop jobs/workers and remove owned indexes.
 * Await this path before process exit; dropping promises can strand children or temp files.
 */
async function dispose() {
  disposed = true;
  notifyAnalysis();
  if (diagnosticTimer) clearTimeout(diagnosticTimer);

  queuedDiagnostics.clear();
  if (timer) clearTimeout(timer);
  for (const w of workers) void stopWorker(w);

  await Promise.all([...workers].map((worker) => stopWorker(worker)));
  await runner.dispose();
  await Promise.all([...sceneIndexes.values()].map((index) => index.dispose()));
}

connection.onShutdown(dispose);
connection.onExit(() => void dispose());
process.on("SIGTERM", () => void dispose().then(() => process.exit(0)));
documents.listen(connection);
connection.listen();
