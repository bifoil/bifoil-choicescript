# Installation and supported features

Branchlight is an unofficial personal project, unaffiliated with Choice of Games or upstream ChoiceScript. Its
independent identifiers are `chinay.branchlight` (VS Code) and `dev.chinay.branchlight` (JetBrains). It bundles the
unchanged ChoiceScript snapshot identified in `vendor/choicescript.lock.json`, sourced from the pinned
`vendor/choicescript` submodule during development.

## Requirements

VS Code desktop 1.109 or newer, or a JetBrains IDE with the built-in `com.intellij.modules.lsp` integration and platform
build 261.26222 or newer. The declared validation matrix is IntelliJ IDEA, WebStorm and PyCharm 2026.1.4, whose
product-specific build suffixes differ; see [exact builds](jetbrains-compatibility.md). IntelliJ IDEA 2026.1.4 remains
the baseline. Other JetBrains products and later builds require their own verifier and launch checks; the module
dependency prevents installation in products without native LSP support. Older Community editions, Android Studio,
browser-only VS Code, debugging, and marketplace publication are outside this release.

Six VSIX variants cover Windows, macOS, and Linux, each on x64 and ARM64. Choose the artifact matching the editor's OS
and CPU. In WSL/SSH remote workspaces, choose the extension host's OS. The JetBrains ZIP includes all six runtimes and
selects one on launch. Packaged plugins include Node.js. Linux binaries require an OS supported by the bundled
official Node distribution (glibc, not Alpine/musl).

## Replacing an earlier development build

Uninstall earlier development builds before installing this version of Branchlight. Its identifiers are
`chinay.branchlight` and `dev.chinay.branchlight`; keeping an older build installed alongside it could start competing
language clients. The quote-warning setting is `branchlight.quoteWarnings`, and saved logs use `.branchlight/logs`.

## Editing

Open a game root containing `scenes/startup.txt`, an engine checkout with `web/mygame/scenes/startup.txt`, or a folder
containing several games. `choicescript.json` can override `scenes`, `assets`, and RandomTest defaults. A scene
directory must contain `startup.txt`. Unrelated `.txt` files stay plain text; explicit ChoiceScript language selection
is also supported.

Both adapters use the same server for semantic tokens, syntax and dialogue diagnostics, completion, hover, definitions,
references, rename, symbols, folding, selection ranges, and narrative word count. Rename changes resolved source
references; it deliberately leaves prose and dynamic string destinations alone. Live templates/snippets, indentation,
comments, bold, and italic are editor commands. Labels and variables are case-insensitive.

Narrative quotes propagate independently of expression strings. Missing command-string quotes produce errors local to
the physical line. Branches, jumps, scene changes, and subroutine summaries carry narrative state. Mixed incoming states
receive neutral styling. Variable types are inferred at references, including static array elements and resolved
indirect values. Loops, recursion, generated text, and unknown destinations can reduce precision; uncertain values are
neutral. Branch feasibility is conservative rather than a full runtime simulation. QuickTest and RandomTest remain the
authority for engine-specific runtime restrictions and uncommon command forms.

To customize VS Code colors, use `editor.semanticTokenColorCustomizations` with selectors such as
`dialogue:choicescript`, `stringVariable:choicescript`, `numberVariable:choicescript`, and
`booleanVariable:choicescript`. Default colors follow the active theme. JetBrains exposes the same categories under
**Editor → Color Scheme → Branchlight**. Toggle narrative warnings through `branchlight.quoteWarnings` or the JetBrains
Tools menu. Syntax diagnostics remain active.

## Game tools

Use **Branchlight** in the VS Code command palette or JetBrains Tools menu. New Project copies the pinned upstream
template into an empty directory and adds its license/provenance. Run Game starts a local snapshot preview; Run again
restarts it. Stop terminates owned preview/test jobs. Both editors offer browser fallback for the embedded preview.
Execution requires editor workspace trust; editing features work without trust.

QuickTest and seeded RandomTest run the official programs in disposable staging directories. Progress is cancellable,
errors point to scene lines, and logs are saved under `.branchlight/logs`. Coverage is reported when the upstream runner
provides it: VS Code marks visited lines and JetBrains prints per-scene counts. Completed results and active previews
are marked stale after edits. Export HTML runs the official compiler and copies required companion assets. Choose a new
destination: existing files are preserved, and collisions are reported.

## Development and validation

Use Git, Node 24, pnpm 12.6.0, and JDK 21. Initialize the pinned engine with
`git -c core.autocrlf=false submodule update --init --recursive`. Builds use repository sources and pinned dependencies.
Python is not a build requirement. If using Python for maintenance, use `uv`.

`pnpm check` verifies the submodule revision and vendored hashes, builds, typechecks, and runs regressions.
`pnpm package:vscode <target>` creates a self-contained VSIX. `pnpm package:intellij` prepares bundled resources; then
`editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin` checks and packages the adapter. The Gradle
wrapper and Plugin Verifier versions are pinned. Use `--write-verification-metadata sha256` when intentionally updating
Gradle dependencies.

`scripts/smoke-bundle.cjs` runs against the selected bundled Node executable and exercises the packaged server and game
tools. `scripts/test-vscode.mjs` starts a real VS Code extension host. On headless Linux, use
`xvfb-run -a node scripts/test-vscode.mjs`. The native adapter includes a platform integration test launching its
bundled server. CI tests extracted VSIX packages on Linux, Windows and macOS, each on x64/ARM64, and native integration
in the three declared JetBrains products. See [development testing](testing.md) for commands and manual editor checks.
