const vscode = require("vscode");
const assert = require("node:assert/strict");
exports.run = async () => {
  const extension = vscode.extensions.getExtension(
    "chira-independent.choicescript-tools-unofficial",
  );
  assert(extension);
  const api = await extension.activate();
  const events = [];
  const subscription = api.onJobEvent((e) => events.push(e));
  const waitFor = async (read) => {
    for (let i = 0; i < 600; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Editor workflow timed out");
  };
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const uri = vscode.Uri.joinPath(folder, "scenes", "startup.txt");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  for (let i = 0; i < 100 && document.languageId !== "choicescript"; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(document.languageId, "choicescript");
  const config = vscode.workspace.getConfiguration("workbench");
  const previous = config.inspect("colorTheme")?.workspaceValue;
  try {
    for (const theme of ["Default Dark Modern", "Default Light Modern"]) {
      await config.update(
        "colorTheme",
        theme,
        vscode.ConfigurationTarget.Workspace,
      );
      let tokens;
      for (let i = 0; i < 100; i++) {
        tokens = await vscode.commands.executeCommand(
          "vscode.provideDocumentSemanticTokens",
          uri,
        );
        if (tokens?.data.length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(tokens?.data.length);
      const legend = await vscode.commands.executeCommand(
        "vscode.provideDocumentSemanticTokensLegend",
        uri,
      );
      assert(legend);
      let line = 0,
        column = 0;
      const spans = [];
      for (let i = 0; i < tokens.data.length; i += 5) {
        column =
          tokens.data[i] === 0
            ? column + tokens.data[i + 1]
            : tokens.data[i + 1];
        line += tokens.data[i];
        spans.push({
          line,
          start: column,
          end: column + tokens.data[i + 2],
          kind: legend.tokenTypes[tokens.data[i + 3]],
        });
      }
      const at = (line, column) =>
        spans.find(
          (s) => s.line === line && column >= s.start && column < s.end,
        )?.kind;
      assert.equal(at(4, 10), "dialogue");
      assert.equal(at(5, 15), "string");
      assert.equal(at(6, 4), "dialogue");
      assert.equal(at(8, 4), "dialogue");
      assert.equal(at(9, 0), "narrative");
      assert(
        !vscode.languages
          .getDiagnostics(uri)
          .some((d) => String(d.code).startsWith("quote-")),
      );
    }
  } finally {
    await config.update(
      "colorTheme",
      previous,
      vscode.ConfigurationTarget.Workspace,
    );
  }
  const definitions = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    uri,
    new vscode.Position(5, 5),
  );
  assert(definitions?.length);
  const completion = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    uri,
    new vscode.Position(5, 5),
  );
  assert(completion.items.some((i) => i.label === "gender"));
  const rename = await vscode.commands.executeCommand(
    "vscode.executeDocumentRenameProvider",
    uri,
    new vscode.Position(5, 5),
    "identity",
  );
  assert(rename.entries().some(([, edits]) => edits.length === 2));
  const editor = await vscode.window.showTextDocument(document);
  const original = document.getText();
  const setText = async (text) => {
    await editor.edit((edit) =>
      edit.replace(new vscode.Range(0, 0, document.lineCount, 0), text),
    );
    editor.selection = new vscode.Selection(0, 0, 0, 0);
  };
  try {
    await setText("Hello");
    editor.selection = new vscode.Selection(0, 0, 0, 5);
    await vscode.commands.executeCommand("choicescriptTools.bold");
    assert.equal(document.getText(), "[b]Hello[/b]");
    editor.selection = new vscode.Selection(
      0,
      0,
      0,
      document.lineAt(0).text.length,
    );
    await vscode.commands.executeCommand("choicescriptTools.italic");
    assert.equal(document.getText(), "[i][b]Hello[/b][/i]");
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand("editor.action.commentLine");
    assert(document.getText().startsWith("*comment"));
    await vscode.commands.executeCommand("editor.action.commentLine");
    assert.equal(document.getText(), "[i][b]Hello[/b][/i]");
    await setText("*if true");
    editor.options = { insertSpaces: true, tabSize: 2, indentSize: 2 };
    editor.selection = new vscode.Selection(0, 8, 0, 8);
    await vscode.commands.executeCommand("type", { text: "\n" });
    assert.equal(document.lineAt(1).text, "  ");
    const fs = require("node:fs/promises"),
      path = require("node:path");
    const snippets = JSON.parse(
      await fs.readFile(
        path.join(extension.extensionPath, "snippets.json"),
        "utf8",
      ),
    );
    const snippet = Object.values(snippets).find((s) => s.prefix === "choice");
    assert(snippet);
    await setText("");
    await editor.insertSnippet(
      new vscode.SnippetString(snippet.body.join("\n")),
    );
    assert(document.getText().includes("*choice"));
    await vscode.commands.executeCommand("leaveSnippet");
    await setText(original.replace("William", "Unsaved William"));
    await waitFor(
      () => !vscode.languages.getDiagnostics(uri).some((d) => d.severity === 0),
    );
    const project = api.projects()[0];
    assert(project);
    const options = { projectId: project.id };
    const command = async (name, extra = {}) => {
      let timer;
      try {
        return await Promise.race([
          vscode.commands.executeCommand("choicescriptTools." + name, {
            ...options,
            ...extra,
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Command timed out: ${name}`)),
              60000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    await waitFor(
      async () =>
        (
          await vscode.commands.executeCommand(
            "vscode.provideDocumentSemanticTokens",
            uri,
          )
        )?.data.length,
    );
    const words = await command("wordCount");
    assert(words > 0);
    const preview = await command("run");
    assert(preview?.url);
    assert(
      (
        await (await fetch(new URL("scenes/startup.txt", preview.url))).text()
      ).includes("Unsaved William"),
    );
    await waitFor(() =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .some((t) => t.label === "Game Preview"),
    );
    await vscode.window.showTextDocument(document);
    await editor.edit((edit) =>
      edit.insert(new vscode.Position(9, 0), "Changed. "),
    );
    await waitFor(() =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .some((t) => t.label.includes("source changed")),
    );
    const restarted = await command("run");
    assert(restarted.url !== preview.url);
    await assert.rejects(fetch(preview.url));
    await command("stop");
    await assert.rejects(fetch(restarted.url));
    await vscode.window.showTextDocument(document);
    for (const operation of ["quicktest", "randomtest"]) {
      const job = await command(operation, { iterations: 2, seed: 42 });
      assert(job?.output);
      assert.equal(
        events.find((e) => e.jobId === job.jobId && e.kind === "completed")
          .exitCode,
        0,
      );
      assert((await fs.readFile(job.output, "utf8")).includes("PASSED"));
      if (operation === "randomtest")
        assert(
          events.some((e) => e.jobId === job.jobId && e.kind === "coverage"),
        );
    }
    const pending = command("randomtest", { iterations: 10000000, seed: 0 });
    const previous = new Set(
      events.filter((e) => e.kind === "started").map((e) => e.jobId),
    );
    const started = await waitFor(() =>
      events.find((e) => e.kind === "started" && !previous.has(e.jobId)),
    );
    await command("stop", { jobId: started.jobId });
    await pending;
    assert.equal(
      events.find((e) => e.jobId === started.jobId && e.kind === "completed")
        .exitCode,
      130,
    );
    const destination = path.join(folder.fsPath, "export/game.html");
    const exported = await command("exportHtml", { destination });
    assert.equal(
      events.find((e) => e.jobId === exported.jobId && e.kind === "completed")
        .exitCode,
      0,
    );
    assert(
      (await fs.readFile(destination, "utf8")).includes("Unsaved William"),
    );
    const created = path.join(folder.fsPath, "created game Ω");
    await command("createProject", {
      destination: created,
      openCreatedProject: false,
    });
    assert(
      (
        await fs.readFile(path.join(created, "UPSTREAM-TEMPLATE.md"), "utf8")
      ).includes("60a6c3e"),
    );
    if (process.env.BRANCHLIGHT_TEST_REPORTS)
      await fs.writeFile(
        path.join(process.env.BRANCHLIGHT_TEST_REPORTS, "workflows.json"),
        JSON.stringify(
          {
            events,
            editor: vscode.version,
            platform: process.platform,
            arch: process.arch,
          },
          null,
          2,
        ),
      );
  } finally {
    await vscode.window.showTextDocument(document);
    await setText(original);
    await vscode.commands.executeCommand(
      "workbench.action.revertAndCloseActiveEditor",
    );
    subscription.dispose();
  }
  const notes = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder, "notes.txt"),
  );
  assert.equal(notes.languageId, "plaintext");
};
