# Branchlight

An unofficial, independent personal project for authoring ChoiceScript games in VS Code and JetBrains IDEs. **Unaffiliated with Choice of Games or the upstream ChoiceScript project.**

The shared TypeScript language server supplies syntax diagnostics, dialogue-aware semantic highlighting, inferred variable colors, completion, hover, navigation, references, rename, symbols, folding, and selection ranges. Editor adapters supply project creation, embedded preview, QuickTest, RandomTest, HTML export, formatting shortcuts, and word counts.

## Install

Download the seven installers and `SHA256SUMS.txt` from the private repository’s Releases page when a prerelease is available. The workflow rebuilds and tests all targets before upload and verifies downloaded hashes. Manual visual gates remain listed in [editor validation](docs/editor-validation.md).

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

Install Node.js 24 LTS, pnpm 10.29.3, and JDK 21 (development only).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:vscode                 # current OS/architecture
pnpm package:vscode win32-x64       # other target
pnpm package:intellij              # bundles all six Node runtimes
cd editors/intellij
./gradlew buildPlugin verifyPlugin
```

Runtime downloads are verified against `runtime-lock.json`. The official ChoiceScript snapshot is already vendored and requires no other checkout. `pnpm generate` regenerates conservative fallback grammar and IntelliJ command metadata. `pnpm test` exercises the shared analyzer and official game tools. `node scripts/extract-vsix.mjs` selects and verifies the packaged extension; then `pnpm exec node scripts/test-vscode.mjs` runs its VS Code extension-host smoke test.

See [architecture](docs/architecture.md), [supported features](docs/support.md), [validation results and remaining release gates](docs/validation.md), and [dependency notices](THIRD_PARTY_NOTICES.md).

The [commit roadmap](docs/commit-roadmap.md) records the implementation sequence and remaining manual gates. The **Private prerelease** workflow accepts a new tag such as `v0.1.0-alpha.1`; run it after signing the intended source history. It publishes only prereleases in a private repository, with six VSIX files, one universal JetBrains ZIP, provenance and checksums.
