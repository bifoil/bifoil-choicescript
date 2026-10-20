import * as vscode from "vscode";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { LanguageClient, LSPErrorCodes, ResponseError, State } from "vscode-languageclient/node";
import {
  CoverageStore,
  ITERATIONS_ERROR,
  type JobEvent,
  type JobRequest,
  type JobResult,
  type Operation,
  parseIterations,
  parseSeed,
  type Project,
  type ProjectsChanged,
  PROTOCOL_VERSION,
  SEED_ERROR,
  SEED_RANGE_ERROR,
  validSeedRange,
} from "@bifoil/choicescript-protocol";

/**
 * Optional editor-command arguments, distinct from the shared wire request.
 * Omitted selections prompt interactively; supply both RandomTest values to skip its dialogs.
 * openCreatedProject=false suppresses opening a new window. Test/export starts allocate
 * their own UUID; jobId remains useful for selecting an existing job to stop.
 */
export interface ToolOptions {
  projectId?: string;
  destination?: string;
  iterations?: number;
  seed?: number;
  jobId?: string;
  openCreatedProject?: boolean;
}

let client: LanguageClient | undefined;

/**
 * Register the editor adapter and start the bundled stdio language client.
 * Returns projects() plus onJobEvent for integrations; listeners must be installed before
 * starting operations. Core language semantics stay in the server, not editor callbacks.
 * Context subscriptions own UI resources; deactivate additionally awaits client shutdown.
 */
// VS Code invokes this exported entry point by name.
// noinspection JSUnusedGlobalSymbols
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Bifoil ChoiceScript"),
    coverage = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
    });
  context.subscriptions.push(output, coverage);

  const coverageStore = new CoverageStore();
  const events = new vscode.EventEmitter<JobEvent>();
  context.subscriptions.push(events);

  const completed = new Map<string, number | undefined>();
  const pendingJobs = new Map<string, { resolve: () => void; progress: vscode.Progress<{ message?: string }> }>();
  let projects: Project[] = [],
    panels = new Map<string, vscode.WebviewPanel>();
  const bundle = context.asAbsolutePath("server"),
    runtime = context.asAbsolutePath(path.join("runtime", process.platform === "win32" ? "node.exe" : "node"));
  const target = `${process.platform}-${process.arch}`;
  const native =
    process.env.BIFOIL_CHOICESCRIPT_NATIVE_SERVER ??
    path.join(
      bundle,
      "native",
      target,
      process.platform === "win32" ? "bifoil-language-server.exe" : "bifoil-language-server",
    );
  if (!existsSync(native))
    throw new Error("The native language server is missing; rebuild or reinstall Bifoil ChoiceScript.");
  client = new LanguageClient(
    "bifoil-choicescript",
    "Bifoil ChoiceScript",
    {
      command: native,
      args: ["--stdio", "--bundle-root", bundle, "--node", existsSync(runtime) ? runtime : process.execPath],
      options: {
        env: {
          ...process.env,
          ...(!existsSync(runtime) ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      },
    },
    {
      documentSelector: [{ scheme: "file", language: "choicescript" }],
      synchronize: { configurationSection: "bifoil.choicescript" },
      outputChannel: output,
    },
  );

  const inside = (root: string, file: string) => {
    const rel = path.relative(root, file);
    return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
  };

  const projectForDocument = (doc: vscode.TextDocument) =>
    doc.uri.scheme === "file" ? projects.find((p) => inside(p.sceneDir, doc.uri.fsPath)) : undefined;

  /**
   * Render only current store results in visible editors; document edits invalidate before repaint.
   * This UI work still needs native scale measurement even when the coverage data is small.
   */
  const renderCoverage = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      const project = projectForDocument(editor.document);
      const scene = project
        ? path
            .relative(project.sceneDir, editor.document.fileName)
            .replace(/\\/g, "/")
            .replace(/\.txt$/i, "")
        : "";
      const counts = project && /\.txt$/i.test(editor.document.fileName) ? coverageStore.counts(project.id, scene) : [];
      const decorations: vscode.DecorationOptions[] = [];
      const rendered = new Set<number>();
      // Keep all coverage facts, but create editor objects only for visible rows.
      // VS Code splits visibleRanges around folds; hidden rows need no markers.
      for (const range of editor.visibleRanges) {
        const end = Math.min(range.end.line, counts.length - 1, editor.document.lineCount - 1);
        for (let line = Math.max(0, range.start.line); line <= end; line++) {
          const count = counts[line];
          if (count <= 0 || rendered.has(line)) continue;
          rendered.add(line);
          decorations.push({
            range: editor.document.lineAt(line).range,
            hoverMessage: "Executed " + count + " time(s).",
          });
        }
      }
      editor.setDecorations(coverage, decorations);
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(renderCoverage),
    vscode.window.onDidChangeTextEditorVisibleRanges(renderCoverage),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (!contentChanges.length) return;

      const project = projectForDocument(document);

      if (project) coverageStore.invalidate(project.id);
      else if (document.uri.scheme === "file" && projects.some((game) => inside(game.assetDir, document.uri.fsPath)))
        void client
          ?.sendNotification("choicescript/assetChanged", { uri: document.uri.toString() })
          .catch((error) => output.appendLine(String(error)));

      renderCoverage();
    }),
  );

  /**
   * Adopt only plain-text .txt files inside discovered scenes; preserve explicit user language selections.
   */
  const associate = async (doc: vscode.TextDocument) => {
    if (
      doc.uri.scheme === "file" &&
      doc.languageId === "plaintext" &&
      /\.txt$/i.test(doc.uri.path) &&
      projects.some((p) => inside(p.sceneDir, doc.uri.fsPath))
    )
      await vscode.languages.setTextDocumentLanguage(doc, "choicescript");
  };

  const update = async (value: Project[]) => {
    projects = value;
    coverageStore.retain(projects.map((project) => project.id));
    for (const doc of vscode.workspace.textDocuments) await associate(doc);

    renderCoverage();
  };

  client.onNotification("choicescript/projectsChanged", (notification: ProjectsChanged) => {
    if (notification.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(notification.projects)) {
      output.appendLine("Unsupported project discovery notification; reinstall matching server and adapter versions.");
      return;
    }
    return update(notification.projects);
  });
  client.onNotification("choicescript/jobEvent", (event: JobEvent) => {
    if (coverageStore.update(event)) renderCoverage();

    events.fire(event);

    if (event.kind === "completed") {
      if (pendingJobs.has(event.jobId)) completed.set(event.jobId, event.exitCode);

      pendingJobs.get(event.jobId)?.resolve();
      pendingJobs.delete(event.jobId);
    }

    if (event.message) pendingJobs.get(event.jobId)?.progress.report({ message: event.message.slice(0, 160) });
    if (event.message) output.appendLine(`[${event.kind}] ${event.message}`);
    if (event.kind === "diagnostic" && event.uri)
      output.appendLine(`${vscode.Uri.parse(event.uri).fsPath}:${(event.line ?? 0) + 1}: ${event.message}`);

    if (event.kind === "completed" && event.exitCode && event.exitCode !== 130)
      void vscode.window.showErrorMessage("Bifoil ChoiceScript operation failed. See Bifoil ChoiceScript output.");

    if (event.kind === "stale") {
      const panel = panels.get(event.jobId);

      if (panel) panel.title = "Game Preview — source changed";
    }
  });

  context.subscriptions.push(
    client.onDidChangeState(({ newState }) => {
      if (newState !== State.Stopped) return;
      for (const pending of pendingJobs.values()) pending.resolve();

      pendingJobs.clear();
      completed.clear();
      coverageStore.retain([]);
      renderCoverage();
      for (const panel of panels.values()) panel.dispose();

      panels.clear();
      output.appendLine("Language server stopped; active operations ended. Restart the server and rerun them.");
    }),
  );
  await client.start();
  await update(await client.sendRequest<Project[]>("choicescript/projects"));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => void associate(doc)));

  async function selectProject() {
    const uri = vscode.window.activeTextEditor?.document.uri,
      active = uri ? projects.find((p) => inside(p.sceneDir, uri.fsPath)) : undefined;

    if (active) return active;
    if (projects.length === 1) return projects[0];

    const selected = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, description: p.root, project: p })),
      { placeHolder: "Select a ChoiceScript project" },
    );

    return selected?.project;
  }

  /**
   * Translate editor selections/options into trusted protocol requests.
   * Test/export commands wait for terminal notification, unlike the wire start response.
   * Register progress and its UUID before sendRequest so immediate events and early cancellation
   * have an owner. A returned handle is not evidence of a successful exit.
   */
  async function job(operation: Operation, options: ToolOptions = {}) {
    if (operation !== "stop" && !vscode.workspace.isTrusted) {
      await vscode.commands.executeCommand("workbench.trust.manage");
      return;
    }

    const request: JobRequest = {
      protocolVersion: PROTOCOL_VERSION,
      operation,
      trusted: vscode.workspace.isTrusted,
      destination: options.destination,
      iterations: options.iterations,
      seed: options.seed,
      jobId: options.jobId,
    };

    if (operation === "stop" && (options.jobId || !projects.length))
      return client!.sendRequest<JobResult>("choicescript/job", { ...request, projectId: options.projectId });

    if (operation === "createProject") {
      if (!request.destination) {
        const parent = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Choose parent folder",
        });

        if (!parent) return;

        const name = await vscode.window.showInputBox({
          prompt: "New project folder name",
          value: "my-choice-game",
          validateInput: (s) =>
            /^[\w -]+$/.test(s) ? undefined : "Use letters, digits, spaces, dashes, or underscores.",
        });

        if (!name) return;

        request.destination = path.join(parent[0].fsPath, name);
      }
    } else {
      const project = options.projectId ? projects.find((p) => p.id === options.projectId) : await selectProject();

      if (!project) {
        void vscode.window.showInformationMessage("Open a folder containing a ChoiceScript scenes/startup.txt file.");
        return;
      }

      request.projectId = project.id;

      if (operation === "randomtest" && (options.iterations === undefined || options.seed === undefined)) {
        const iterations = await vscode.window.showInputBox({
          prompt: "RandomTest iterations",
          value: String(project.randomtest?.iterations ?? 1000),
          validateInput: (v) => (parseIterations(v) === undefined ? ITERATIONS_ERROR : undefined),
        });

        if (!iterations) return;

        const seed = await vscode.window.showInputBox({
          prompt: "RandomTest seed",
          value: String(project.randomtest?.seed ?? 0),
          validateInput: (v) =>
            parseSeed(v) === undefined
              ? SEED_ERROR
              : validSeedRange(parseSeed(v)!, parseIterations(iterations)!)
                ? undefined
                : SEED_RANGE_ERROR,
        });

        if (seed === undefined) return;

        request.iterations = parseIterations(iterations);
        request.seed = parseSeed(seed);
      }

      if (operation === "exportHtml" && !request.destination) {
        const dest = await vscode.window.showSaveDialog({
          filters: { HTML: ["html"] },
          defaultUri: vscode.Uri.file(path.join(project.root, "export", "game.html")),
        });

        if (!dest) return;

        request.destination = dest.fsPath;
      }
    }

    output.show(true);

    if (operation === "run") {
      for (const [id, panel] of panels) {
        panel.dispose();
        panels.delete(id);
      }

      await client!.sendRequest("choicescript/job", {
        ...request,
        operation: "stop",
      });
    }

    let result: JobResult;

    if (["quicktest", "randomtest", "exportHtml"].includes(operation)) {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Bifoil ChoiceScript " + operation,
          cancellable: true,
        },
        async (progress, cancellation) => {
          request.jobId = randomUUID();

          const id = request.jobId;
          const session = client!;
          let settle!: () => void;
          const completion = new Promise<void>((resolve) => {
            settle = resolve;
          });
          pendingJobs.set(id, { resolve: settle, progress });

          const cancel = () => {
            void session
              .sendRequest("choicescript/job", { ...request, operation: "stop", jobId: id })
              .catch((error) => {
                output.appendLine(String(error));
                settle();
              });
          };

          const subscription = cancellation.onCancellationRequested(cancel);

          try {
            const starting = session.sendRequest<JobResult>("choicescript/job", request);

            if (cancellation.isCancellationRequested) cancel();

            const started = await starting;

            if (!completed.has(id) && session.state === State.Running) await completion;

            return started;
          } catch (error) {
            if (
              cancellation.isCancellationRequested ||
              completed.get(id) === 130 ||
              (error instanceof ResponseError && error.code === LSPErrorCodes.RequestCancelled)
            )
              return { jobId: id, projectId: request.projectId! };

            throw error;
          } finally {
            subscription.dispose();
            pendingJobs.delete(id);
            completed.delete(id);
          }
        },
      );
    } else result = await client!.sendRequest<JobResult>("choicescript/job", request);

    if (result.url) {
      const panel = vscode.window.createWebviewPanel("choicescriptGame", "Game Preview", vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panels.set(result.jobId, panel);

      const escaped = result.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      panel.webview.html = `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline'"><style>html,body,iframe{width:100%;height:100%;border:0;margin:0}a{position:fixed;right:12px;top:8px;background:white;padding:4px;color:#222}</style></head><body><iframe src="${escaped}" title="ChoiceScript game"></iframe><a href="${escaped}">Open in browser</a></body></html>`;
      panel.onDidDispose(() => {
        panels.delete(result.jobId);
        void client
          ?.sendRequest("choicescript/job", {
            protocolVersion: PROTOCOL_VERSION,
            operation: "stop",
            projectId: result.projectId,
            jobId: result.jobId,
            trusted: vscode.workspace.isTrusted,
          })
          .catch((error) => output.appendLine(String(error)));
      });
    }

    if (operation === "createProject" && request.destination && options.openCreatedProject !== false)
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(request.destination), true);

    return result;
  }

  for (const operation of ["createProject", "run", "stop", "quicktest", "randomtest", "exportHtml"] as Operation[])
    context.subscriptions.push(
      vscode.commands.registerCommand("bifoil.choicescript." + operation, (options?: ToolOptions) =>
        job(operation, options).catch((e) => vscode.window.showErrorMessage(String(e))),
      ),
    );

  for (const [name, tag] of [
    ["bold", "b"],
    ["italic", "i"],
  ])
    context.subscriptions.push(
      vscode.commands.registerCommand("bifoil.choicescript." + name, () => {
        const editor = vscode.window.activeTextEditor;

        if (editor)
          return editor.edit((edit) => {
            for (const selection of editor.selections)
              edit.replace(selection, `[${tag}]${editor.document.getText(selection)}[/${tag}]`);
          });
      }),
    );

  context.subscriptions.push(
    vscode.commands.registerCommand("bifoil.choicescript.wordCount", async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;

      if (uri) {
        const count = await client!.sendRequest<number>("choicescript/wordCount", { uri: uri.toString() });
        void vscode.window.showInformationMessage(`Narrative word count: ${count}`);
        return count;
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bifoil.choicescript.about", () =>
      vscode.window.showInformationMessage(
        "Bifoil ChoiceScript 0.1.0 — an unofficial Bifoil Foundation project, unaffiliated with Choice of Games or upstream ChoiceScript.",
      ),
    ),
  );

  context.subscriptions.push({
    dispose: () => {
      for (const pending of pendingJobs.values()) pending.resolve();

      pendingJobs.clear();
      for (const panel of panels.values()) panel.dispose();

      void client?.stop();
    },
  });

  return { onJobEvent: events.event, projects: () => [...projects] };
}

/**
 * Await language-client shutdown so the server can settle its owned jobs and temporary resources.
 */
// VS Code invokes this exported entry point by name.
// noinspection JSUnusedGlobalSymbols
export async function deactivate() {
  await client?.stop();
}
