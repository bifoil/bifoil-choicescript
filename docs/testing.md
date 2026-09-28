# Development testing

Install the development dependencies described in [the build instructions](../README.md#build-from-a-fresh-checkout).

## Shared language service and game tools

```sh
pnpm check
```

This verifies the pinned engine checksums, builds the project, checks TypeScript types, and runs the regression and
integration suites. Tests use synthetic scenes and the pinned interpreter to cover parsing, dialogue flow, variable
types, project discovery, LSP requests, and game-tool jobs.

To analyze additional local scene files without executing game code:

```sh
pnpm test:corpus "/path/to/game" "/path/to/scene-fragments"
pnpm test:corpus --details "/path/to/game"
```

The command reads the selected directories and prints JSON summaries. `--details` adds relative source locations and
diagnostic messages. It creates no game files or staging copies. A directory without a detected project is treated as
explicitly selected scene fragments; unrelated text files are not associated automatically.

Each directory runs in a separate process with a 1 GiB V8 heap limit and a 60-second timeout. Errors, invalid
semantic-token ranges, truncated analysis, and worker failures produce a nonzero exit status. Narrative warnings alone
do not fail a run.

## Packaged VS Code extension

```sh
pnpm package:vscode
node scripts/extract-vsix.mjs
node scripts/test-bundle.mjs
node scripts/test-vscode.mjs
```

The extension-host test uses the extracted VSIX, an isolated editor profile, and a temporary game. Use
`xvfb-run -a node scripts/test-vscode.mjs` on headless Linux. `BRANCHLIGHT_EXTENSION_PATH` selects an extracted
extension, and `BRANCHLIGHT_VSCODE_EXECUTABLE` selects an editor installation. Diagnostic output is written to
`dist/test-results/editor`.

## JetBrains adapter

```sh
pnpm package:intellij
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

Packaging prepares the bundled server and runtimes required by native integration tests. Select another supported
product with `-PplatformProduct=webstorm` or `-PplatformProduct=pycharm`; IDEA is the default.
See [platform compatibility](jetbrains-compatibility.md) for the supported baselines.

## Manual editor checks

Install the built plugin and open the synthetic dialogue fixture in `fixtures/dialogue`. Exercise both runtime branch
outcomes and check:

- Dialogue and variable colors in light and dark themes.
- Completion, navigation, rename, indentation, comments, and formatting actions.
- Embedded preview, advancing choices, browser fallback, restart, and stop.
- Unsaved edits, stale results, test cancellation, failure links, and coverage display.
- Export to a new destination, protection of existing files, and cleanup after editor shutdown.

## Programmatic VS Code commands

Tool commands accept an optional object with `projectId`, `destination`, `iterations`, `seed`, and `jobId`. Create
Project also accepts `openCreatedProject: false`. Missing interactive choices prompt normally. Arguments cannot override
workspace trust, the operation, or protocol version. Commands return their `JobResult`; test/export commands finish
after job completion. The extension API exposes `projects()` and `onJobEvent` for integrations. Word Count returns the
count as well as displaying it.
