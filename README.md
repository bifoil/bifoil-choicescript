# Branchlight

An unofficial, independent personal project for authoring ChoiceScript games in VS Code and JetBrains IDEs. **Unaffiliated with Choice of Games or the upstream ChoiceScript project.**

The shared TypeScript language server supplies syntax diagnostics, dialogue-aware semantic highlighting, inferred variable colors, completion, hover, navigation, references, rename, symbols, folding, and selection ranges. Editor adapters supply project creation, embedded preview, QuickTest, RandomTest, HTML export, formatting shortcuts, and word counts.

## Install

Download the installer for your platform and `SHA256SUMS.txt` from the private repository’s Releases page when a prerelease is available. See the [release notes](docs/release-notes.md) for features and limitations.

Build artifacts are placed in `dist/packages` (VSIX) and `editors/intellij/build/distributions` (JetBrains ZIP). Install a VSIX using VS Code's **Extensions: Install from VSIX** command. In a compatible JetBrains IDE, use **Settings → Plugins → Install Plugin from Disk**. Node.js is included in packaged plugins.

Open an existing game directory containing `scenes/startup.txt`, or use **Branchlight → New Project**. Only detected scene `.txt` files are associated automatically; unrelated text files remain plain text. You can also select the ChoiceScript language explicitly. Multiple games in one workspace are supported.

Run commands from the command palette/Tools menu. Running, testing, and exporting require a trusted project. Test logs are saved under `.branchlight/logs`. Preview and tests use snapshots including unsaved editor buffers; changing source marks running results stale. Restart preview to see changes. Export to a new directory to avoid overwriting companion assets.

## Quotes

Expression strings such as `*set name "Alex"` must close on their source line. Dialogue is analyzed separately and may cross newlines, conditionals, scene transitions, and subroutine calls. Each alternative inherits the same incoming dialogue state. Quotes in commands never toggle the surrounding dialogue state. Narrative warnings can be disabled separately from syntax diagnostics.

When dynamic scene targets, generated string contents, or paths disagree, highlighting is conservative. Type colors are inferred at each reference, not permanent declarations of a variable's type. Unknown/mixed types retain the normal variable style. No game code runs during static analysis.

## Project configuration

`choicescript.json` is optional:

```json
{"scenes":"scenes","assets":".","randomtest":{"iterations":1000,"seed":0}}
```

Paths are relative to the configuration file. Keep generated exports outside the game assets directory where possible.

## Build from a fresh checkout

Install Git, Node.js 24 LTS, pnpm 12.6.0, and JDK 21 (development only).

Clone with the pinned submodule, preserving upstream line endings on every OS:

```sh
git -c core.autocrlf=false clone --recurse-submodules https://github.com/Chinay-Domitrix/branchlight.git
cd branchlight
```

For an existing checkout, run `git -c core.autocrlf=false submodule update --init --recursive` before building and after pulling changes to the engine pin.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:vscode                 # current OS/architecture
pnpm package:vscode win32-x64       # other target
pnpm package:intellij              # bundles all six Node runtimes
cd editors/intellij
./gradlew buildPlugin verifyPlugin
```

Dependency build-script decisions are checked into `pnpm-workspace.yaml`: esbuild and the VS Code signing helper are allowed; keytar, used for Marketplace credential storage, is disabled. CI reads the pnpm version from `package.json`.

Runtime downloads are verified against `runtime-lock.json`. The official ChoiceScript engine is pinned as the `vendor/choicescript` Git submodule. Builds verify its commit and file checksums, then copy its sources without Git metadata into the plugins. Packaged installations require neither Git nor a separate engine checkout. `pnpm generate` regenerates conservative fallback grammar and IntelliJ command metadata. `pnpm test` exercises the shared analyzer and official game tools. `node scripts/extract-vsix.mjs` selects and verifies the packaged extension; then `pnpm exec node scripts/test-vscode.mjs` runs its VS Code extension-host smoke test.

Use `pnpm test:corpus "/path/to/game"` to run read-only analysis against local game sources. See [development testing](docs/testing.md) for command options and editor test instructions.

See [architecture](docs/architecture.md), [supported features](docs/support.md), [development testing](docs/testing.md), and [dependency notices](THIRD_PARTY_NOTICES.md).

The **Private prerelease** workflow accepts a new tag such as `v0.1.0-alpha.1`; run it after signing the intended source history. It publishes only prereleases in a private repository, with six VSIX files, one universal JetBrains ZIP, provenance and checksums.
