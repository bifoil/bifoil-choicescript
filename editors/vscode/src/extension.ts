import * as vscode from "vscode";
import path from "node:path";
import { existsSync } from "node:fs";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";
import type {
  Project,
  JobEvent,
  JobRequest,
  JobResult,
  Operation,
} from "../../../packages/protocol/src/index.js";
export interface ToolOptions {
  projectId?: string;
  destination?: string;
  iterations?: number;
  seed?: number;
  jobId?: string;
  openCreatedProject?: boolean;
}
let client: LanguageClient | undefined;
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("ChoiceScript Tools"),
    coverage = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(
        "diffEditor.insertedTextBackground",
      ),
    });
  context.subscriptions.push(output, coverage);
  const events = new vscode.EventEmitter<JobEvent>();
  context.subscriptions.push(events);
  const completed = new Set<string>();
  const pendingJobs = new Map<
    string,
    { resolve: () => void; progress: vscode.Progress<{ message?: string }> }
  >();
  let projects: Project[] = [],
    panels = new Map<string, vscode.WebviewPanel>();
  const bundle = context.asAbsolutePath("server"),
    runtime = context.asAbsolutePath(
      path.join("runtime", process.platform === "win32" ? "node.exe" : "node"),
    );
  client = new LanguageClient(
    "choicescriptTools",
    "ChoiceScript Tools",
    {
      command: existsSync(runtime) ? runtime : process.execPath,
      args: [
        path.join(bundle, "server.cjs"),
        "--stdio",
        "--bundle-root",
        bundle,
      ],
      transport: TransportKind.stdio,
      options: {
        env: {
          ...process.env,
          ...(!existsSync(runtime) ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      },
    },
    {
      documentSelector: [{ scheme: "file", language: "choicescript" }],
      synchronize: { configurationSection: "choicescriptTools" },
      outputChannel: output,
    },
  );
  const inside = (root: string, file: string) => {
    const rel = path.relative(root, file);
    return (
      rel === "" ||
      (!rel.startsWith(".." + path.sep) &&
        rel !== ".." &&
        !path.isAbsolute(rel))
    );
  };
  const associate = async (doc: vscode.TextDocument) => {
    if (
      doc.uri.scheme === "file" &&
      doc.languageId === "plaintext" &&
      doc.uri.path.endsWith(".txt") &&
      projects.some((p) => inside(p.sceneDir, doc.uri.fsPath))
    )
      await vscode.languages.setTextDocumentLanguage(doc, "choicescript");
  };
  const update = async (value: Project[]) => {
    projects = value;
    for (const doc of vscode.workspace.textDocuments) await associate(doc);
  };
  client.onNotification("choicescript/projectsChanged", update);
  client.onNotification("choicescript/jobEvent", (event: JobEvent) => {
    events.fire(event);
    if (event.kind === "completed") {
      completed.add(event.jobId);
      pendingJobs.get(event.jobId)?.resolve();
      pendingJobs.delete(event.jobId);
    }
    if (event.message)
      pendingJobs
        .get(event.jobId)
        ?.progress.report({ message: event.message.slice(0, 160) });
    if (event.message) output.appendLine(`[${event.kind}] ${event.message}`);
    if (event.kind === "diagnostic" && event.uri)
      output.appendLine(
        `${vscode.Uri.parse(event.uri).fsPath}:${(event.line ?? 0) + 1}: ${event.message}`,
      );
    if (event.kind === "completed" && event.exitCode && event.exitCode !== 130)
      void vscode.window.showErrorMessage(
        "ChoiceScript operation failed. See ChoiceScript Tools output.",
      );
    if (event.kind === "stale") {
      for (const editor of vscode.window.visibleTextEditors)
        editor.setDecorations(coverage, []);
      const panel = panels.get(event.jobId);
      if (panel) panel.title = "Game Preview — source changed";
    }
    if (event.kind === "coverage" && event.coverage)
      for (const editor of vscode.window.visibleTextEditors) {
        const scene = path.basename(editor.document.fileName, ".txt");
        editor.setDecorations(
          coverage,
          (event.coverage[scene] ?? []).flatMap((count, line) =>
            count > 0 && line < editor.document.lineCount
              ? [editor.document.lineAt(line).range]
              : [],
          ),
        );
      }
  });
  await client.start();
  await update(await client.sendRequest<Project[]>("choicescript/projects"));
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => void associate(doc)),
  );
  async function selectProject() {
    const uri = vscode.window.activeTextEditor?.document.uri,
      active = uri
        ? projects.find((p) => inside(p.sceneDir, uri.fsPath))
        : undefined;
    if (active) return active;
    if (projects.length === 1) return projects[0];
    const selected = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, description: p.root, project: p })),
      { placeHolder: "Select a ChoiceScript project" },
    );
    return selected?.project;
  }
  async function job(operation: Operation, options: ToolOptions = {}) {
    if (operation !== "stop" && !vscode.workspace.isTrusted) {
      await vscode.commands.executeCommand("workbench.trust.manage");
      return;
    }
    const request: JobRequest = {
      protocolVersion: 1,
      operation,
      trusted: vscode.workspace.isTrusted,
      destination: options.destination,
      iterations: options.iterations,
      seed: options.seed,
      jobId: options.jobId,
    };
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
            /^[\w -]+$/.test(s)
              ? undefined
              : "Use letters, digits, spaces, dashes, or underscores.",
        });
        if (!name) return;
        request.destination = path.join(parent[0].fsPath, name);
      }
    } else {
      const project = options.projectId
        ? projects.find((p) => p.id === options.projectId)
        : await selectProject();
      if (!project) {
        void vscode.window.showInformationMessage(
          "Open a folder containing a ChoiceScript scenes/startup.txt file.",
        );
        return;
      }
      request.projectId = project.id;
      if (
        operation === "randomtest" &&
        (options.iterations === undefined || options.seed === undefined)
      ) {
        const iterations = await vscode.window.showInputBox({
          prompt: "RandomTest iterations",
          value: String(project.randomtest?.iterations ?? 1000),
          validateInput: (v) =>
            /^\d+$/.test(v) && Number(v) > 0 && Number(v) <= 10000000
              ? undefined
              : "Enter 1–10,000,000.",
        });
        if (!iterations) return;
        const seed = await vscode.window.showInputBox({
          prompt: "RandomTest seed",
          value: String(project.randomtest?.seed ?? 0),
          validateInput: (v) =>
            /^-?\d+$/.test(v) ? undefined : "Enter an integer.",
        });
        if (seed === undefined) return;
        request.iterations = Number(iterations);
        request.seed = Number(seed);
      }
      if (operation === "exportHtml" && !request.destination) {
        const dest = await vscode.window.showSaveDialog({
          filters: { HTML: ["html"] },
          defaultUri: vscode.Uri.file(
            path.join(project.root, "export", "game.html"),
          ),
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
          title: "ChoiceScript " + operation,
          cancellable: true,
        },
        async (progress, cancellation) => {
          const started = await client!.sendRequest<JobResult>(
            "choicescript/job",
            request,
          );
          const cancel = () =>
            void client?.sendRequest("choicescript/job", {
              ...request,
              operation: "stop",
              jobId: started.jobId,
            });
          const subscription = cancellation.onCancellationRequested(cancel);
          try {
            if (cancellation.isCancellationRequested) cancel();
            if (!completed.has(started.jobId))
              await new Promise<void>((resolve) =>
                pendingJobs.set(started.jobId, { resolve, progress }),
              );
            return started;
          } finally {
            subscription.dispose();
            completed.delete(started.jobId);
          }
        },
      );
    } else
      result = await client!.sendRequest<JobResult>(
        "choicescript/job",
        request,
      );
    if (result.url) {
      const panel = vscode.window.createWebviewPanel(
        "choicescriptGame",
        "Game Preview",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panels.set(result.jobId, panel);
      const escaped = result.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline'"><style>html,body,iframe{width:100%;height:100%;border:0;margin:0}a{position:fixed;right:12px;top:8px;background:white;padding:4px;color:#222}</style></head><body><iframe src="${escaped}" title="ChoiceScript game"></iframe><a href="${escaped}">Open in browser</a></body></html>`;
      panel.onDidDispose(() => {
        panels.delete(result.jobId);
        void client?.sendRequest("choicescript/job", {
          protocolVersion: 1,
          operation: "stop",
          projectId: result.projectId,
          jobId: result.jobId,
          trusted: vscode.workspace.isTrusted,
        });
      });
    }
    if (
      operation === "createProject" &&
      request.destination &&
      options.openCreatedProject !== false
    )
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(request.destination),
        true,
      );
    return result;
  }
  for (const operation of [
    "createProject",
    "run",
    "stop",
    "quicktest",
    "randomtest",
    "exportHtml",
  ] as Operation[])
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "choicescriptTools." + operation,
        (options?: ToolOptions) =>
          job(operation, options).catch((e) =>
            vscode.window.showErrorMessage(String(e)),
          ),
      ),
    );
  for (const [name, tag] of [
    ["bold", "b"],
    ["italic", "i"],
  ])
    context.subscriptions.push(
      vscode.commands.registerCommand("choicescriptTools." + name, () => {
        const editor = vscode.window.activeTextEditor;
        if (editor)
          return editor.edit((edit) => {
            for (const selection of editor.selections)
              edit.replace(
                selection,
                `[${tag}]${editor.document.getText(selection)}[/${tag}]`,
              );
          });
      }),
    );
  context.subscriptions.push(
    vscode.commands.registerCommand("choicescriptTools.wordCount", async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri) {
        const count = await client!.sendRequest<number>(
          "choicescript/wordCount",
          { uri: uri.toString() },
        );
        void vscode.window.showInformationMessage(
          `Narrative word count: ${count}`,
        );
        return count;
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("choicescriptTools.about", () =>
      vscode.window.showInformationMessage(
        "Branchlight 0.1.0 — ChoiceScript Tools — an unofficial personal project, unaffiliated with Choice of Games or upstream ChoiceScript.",
      ),
    ),
  );
  context.subscriptions.push({
    dispose: () => {
      for (const panel of panels.values()) panel.dispose();
      void client?.stop();
    },
  });
  return { onJobEvent: events.event, projects: () => [...projects] };
}
export async function deactivate() {
  await client?.stop();
}
