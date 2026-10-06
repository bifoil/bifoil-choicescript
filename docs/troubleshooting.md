# Troubleshooting

Start with the **Bifoil ChoiceScript** output channel in VS Code or **Bifoil ChoiceScript** tool window in JetBrains. Game-tool completion messages include the saved log path. Keep the editor version, plugin version, and exact error when reporting a problem.

## A scene stays plain text

- Open the game folder as a workspace/project and check that its scene directory contains `startup.txt`.
- For a custom layout, check the paths in [choicescript.json](configuration.md#project-layout). They resolve from the configuration file's directory.
- If the game is buried in a larger directory tree, open it directly. Automatic discovery has a depth limit and skips hidden and dependency/build directories.
- For a standalone scene, explicitly choose the ChoiceScript language/file type. Bifoil ChoiceScript deliberately does not associate all `.txt` files globally.
- Check for another extension or file-type association already claiming the file. Reload the window/project after correcting the layout if discovery has not refreshed.

## Basic colors appear, but dialogue or type colors do not

Basic syntax colors can come from the fallback lexer while the language service is unavailable. Check the output for a server startup error. In VS Code, ensure semantic highlighting is enabled for ChoiceScript; in JetBrains, inspect the Bifoil ChoiceScript color scheme entries.

If the server is running, neutral colors may be intentional: unresolved jumps or generated text can make dialogue uncertain, and mixed variable types retain neutral styling. See [language behavior](specification.md) before treating neutral text as a lexer failure.

## The plugin or bundled runtime will not start

Confirm the [supported editor baseline](support.md) and choose a package matching the extension host's operating system and CPU. Linux builds require glibc. In WSL/SSH, the extension host may differ from your desktop machine.

JetBrains requires the native LSP module. An older Community edition or a different product is not covered by the declared matrix. A newer build is not automatically verified just because the plugin can be installed.

If an artifact or runtime checksum fails, download a fresh copy of the matching package and preserve the error in your report. Installing system Node.js is not the normal fix for a packaged plugin: its runtime is bundled.

## Run or test commands ask for trust

Trust the workspace/project through your editor's normal controls if you intend to execute its game code. Preview, tests, export, and project creation require trust. Editing, syntax analysis, and navigation remain available without it.

## Preview shows old text or cannot open in a browser

Preview uses the snapshot captured when **Run Game** started. Run it again after editing; Bifoil ChoiceScript does not automatically restart a playthrough. A title indicating source changes means the snapshot is stale.

Keep the preview job running while using its browser URL. Closing the embedded preview or choosing **Stop Game or Tests** stops its server. For remote development, forward the preview's loopback port from the extension host before using a local browser.

If the embedded browser fails, try its **Open in Browser** control. JetBrains falls back to a browser when JCEF is unavailable. Include whether the failure occurs in the embedded panel, external browser, or both in a report.

## A test fails, or coverage seems incomplete

Read the first reported scene location and the saved `.bifoil-choicescript/logs/<job-id>.log`. Reproduce RandomTest failures using the same source, seed, and iteration count. Rerun after edits because earlier results are stale.

Coverage is available only when reported by the runner. VS Code decorates visible scenes; JetBrains prints a summary. Coverage from one randomized run does not establish that every path was explored.

## Export fails on an existing file

Choose a new HTML filename in an empty directory. Bifoil ChoiceScript protects both the HTML destination and companion assets from overwrites. A failed copy can leave part of an export behind, so use a fresh directory for the retry. Keep exported companion assets beside the HTML file.

## A source build fails on the engine check

Initialize the pinned submodule with `git -c core.autocrlf=false submodule update --init --recursive`. Builds verify both its commit and file contents. Do not edit the vendored engine to make a build pass.

On Windows, line-ending conversion can invalidate the upstream checksums. Follow the clone command in [Contributing](../CONTRIBUTING.md#build-from-source), which disables automatic conversion. Preserve any local work before repairing an existing checkout; a fresh correctly configured clone is a useful comparison.

## Development builds use too much disk space

JetBrains SDKs and verifier downloads are much larger than the source tree. Build one IDE product at a time and use `pnpm package:intellij --current` for a host-only development bundle.

Generated output includes `dist/`, repository `.cache/`, `editors/intellij/build/`, and `editors/intellij/src/main/resources/bundle/`. Stop relevant runs before removing generated output; the next build or packaging step recreates it. Dependency caches may be shared with other projects, so avoid deleting them as part of routine repository cleanup. Old game logs can be removed from that game's `.bifoil-choicescript/logs/` once no active run is writing them.

## Reporting a problem

Open an [issue](https://github.com/bifoil/bifoil-choicescript/issues) with:

1. Editor name and full version/build, operating system and CPU, and Bifoil ChoiceScript version.
2. Whether the editor is local, WSL, or SSH, and which host runs the extension.
3. A small original scene demonstrating the issue, including relevant `startup.txt` declarations and configuration.
4. Expected and observed behavior, exact reproduction steps, and relevant output.
5. For RandomTest, the iteration count and seed; for highlighting, the theme and semantic-highlighting setting.

Remove personal paths, credentials, and unrelated story text from logs and examples. A minimal synthetic reproduction is easier to diagnose than a full game. Repository access is currently required to open an issue.
