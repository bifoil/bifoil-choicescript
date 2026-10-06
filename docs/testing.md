# Test a Bifoil ChoiceScript change

This guide is for plugin development. To test a story from the editor, use the [game testing guide](usage.md#quicktest-and-randomtest). Install source dependencies using [Contributing](../CONTRIBUTING.md#build-from-source) before running the commands below, all from the repository root.

## Shared checks

```sh
pnpm check
```

This verifies the pinned engine, builds the bundles, checks TypeScript types, and runs regression and integration tests. Coverage includes parsing and recovery, dialogue flow, variable types, project discovery, real LSP requests, and official game-tool jobs.

For a targeted investigation, `pnpm typecheck` and `pnpm test` are separate commands. Run `pnpm build` before tests that exercise built bundles.

Add small original regressions alongside the affected package tests. Analysis changes should cover both the result and source ranges, especially around malformed strings, branch joins, indirect references, CRLF, Unicode, and edits. Keep sample scenes under package tests or `fixtures/`; documentation is not a corpus or a store of test results.

## Analyze local scenes

The corpus command performs read-only analysis without executing game code or copying sources into this repository:

```sh
pnpm test:corpus "/path/to/game" "/path/to/scene-fragments"
pnpm test:corpus --details "/path/to/game"
```

It prints JSON summaries; `--details` adds relative locations and diagnostic messages. A directory without a discovered project is treated as explicitly selected scene fragments.

Each directory runs in a separate process with a 1 GiB V8 heap limit and a 60-second timeout. Analysis errors, invalid token ranges, truncated analysis, and worker failures produce a nonzero exit status. Narrative warnings alone do not fail the run. Keep local sources and generated reports outside public documentation and committed fixtures.

## Packaged VS Code checks

After shared checks pass:

```sh
pnpm package:vscode
node scripts/extract-vsix.mjs
node scripts/test-bundle.mjs
node scripts/test-vscode.mjs
```

Extraction verifies the package target and bundled runtime checksums. The tests use the extracted VSIX, an isolated editor profile, and a temporary game. On headless Linux, replace the last command with:

```sh
xvfb-run -a node scripts/test-vscode.mjs
```

`BIFOIL_CHOICESCRIPT_EXTENSION_PATH` selects an extracted extension directory. `BIFOIL_CHOICESCRIPT_VSCODE_EXECUTABLE` selects an existing editor executable instead of the default downloaded test installation. Editor diagnostics go to `dist/test-results/editor`.

These checks exercise packaged code, so rebuild and repackage after changing the implementation.

## JetBrains checks

For a single-host development check, after building the shared bundles:

```sh
pnpm package:intellij --current
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

Use `editors\intellij\gradlew.bat` on Windows without Bash. IDEA is the default product; select another baseline with `-PplatformProduct=webstorm` or `-PplatformProduct=pycharm`. SDK downloads are large, so start with the product affected by your change.

Release checks prepare all runtimes with `pnpm package:intellij` and run all three products. Native tests and Plugin Verifier serve different purposes: tests exercise adapter behavior, while the verifier checks platform API compatibility. See [the compatibility matrix](jetbrains-compatibility.md) and [API maintenance notes](jetbrains-api-notes.md).

## Manual acceptance

Install the packaged plugins and open `fixtures/dialogue`. Check both runtime outcomes of the dialogue example in both editors, then exercise:

- Dialogue and variable styles in light and dark themes, including ordinary prose after a branch closes a quote.
- Completion, hover, navigation, references, rename, folding, selections, indentation, comments, and markup actions.
- File association inside a game without changing unrelated text files.
- Embedded preview, advancing choices, browser fallback, explicit restart, and stop.
- Unsaved buffers, stale results, cancellation, clickable failure locations, and each editor's coverage presentation.
- Export to a fresh directory, collision handling, companion assets, and cleanup after shutdown.

Include spaces and Unicode in project paths. Static classifications can agree while a theme or UI action still behaves poorly, so automated tests do not replace these checks.

## CI and reporting

[Build and verify](../.github/workflows/ci.yml) runs six operating-system/architecture jobs for VS Code packaging and editor smoke tests, plus native tests and Plugin Verifier for IDEA, WebStorm, and PyCharm. Diagnostic artifacts are uploaded even on failures when reports exist.

In a pull request, record the commands and platforms actually checked, and explain anything left unverified. Keep detailed local output in ignored `.bifoil-choicescript/development/`. A release must also account for outstanding [manual acceptance](release-notes.md#known-limitations).
