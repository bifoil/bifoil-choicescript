# Validation record — 0.1.0 candidate

Validation performed on 2026-09-27. Automated checks below are distinct from the still-open manual visual gates. This remains an unofficial personal project, unaffiliated with Choice of Games or upstream ChoiceScript.

## Shared service and tools

`pnpm check` passes engine verification, builds, TypeScript checking and **38 tests**. The original 69 engine files retain their pinned checksums. New differential tests compare expressions, arrays, indirect references, interpolation, multireplace and escapes against the pinned interpreter, with 48 seeded conditional/recovery mutations. Both runtime gender outcomes remain covered.

Real LSP subprocess checks exercise rapid edits including a 20,000-line snapshot, cancellation, dependency edits, buffer close, configuration changes, file creation/deletion and multiple games. They exposed obsolete workspace symbols and a Windows drive-letter/URI-encoding bug; the fixes suppress obsolete results and deduplicate disk/open-buffer snapshots.

Tooling checks cover unsaved snapshots, spaces/Unicode paths, seeded coverage, saved output and source locations, concurrent preview restart, cancellation, shutdown during staging, failed tests, export collisions and successful subsequent runs. The packaged smoke test exercises these operations through the installed server and bundled Node.

## Executed editor and platform checks

- All six JavaScript platform jobs passed at `553f1d6`: Linux, Windows and macOS on x64/ARM64. Each extracts the VSIX and runs its bundled server, preview, QuickTest, seeded RandomTest and export, as well as the VS Code 1.109.0 extension-host classification/navigation checks. [Run 36357782106](https://github.com/Chinay-Domitrix/branchlight/actions/runs/36357782106).
- The expanded command-level VS Code workflow passed locally on Linux x64 and Windows x64 with extracted VSIX packages: formatting, comments, indentation, snippets, word count, snapshot preview/webview, stale title, restart/stop, QuickTest, RandomTest/coverage/logs, cancellation, export and project creation. The final CI run applies these expanded checks to every target.
- **Six native tests** pass locally on IntelliJ IDEA 2026.1.4, build 261.26222.65: fallback lexer/recovery, project detection/PSI, packaged LSP classification/completion/rename/trust refusal, light/dark theme attributes, formatting actions, comments, indentation and templates.
- Plugin Verifier 1.410 reports **Compatible** on the IDEA baseline after the API cleanup, with no deprecated or experimental bytecode usages reported. The native LSP API remains experimental by contract; see [maintenance notes](jetbrains-api-notes.md).
- IDEA, WebStorm and PyCharm 2026.1.4 all passed native tests and Plugin Verifier at `13406c3` in [run 36358272758](https://github.com/Chinay-Domitrix/branchlight/actions/runs/36358272758). Earlier WebStorm/PyCharm attempts exhausted the hosted runner disk; native CI now disables the broad Gradle cache and removes unused Android/.NET SDKs from its disposable runner. The two Windows editor jobs in that run exposed missing path quoting in the test launcher; the fix was then verified in a real Windows VS Code host with spaces and Unicode in the game path. The final branding commit is checked again by the complete matrix.
- Release-manifest checks passed locally with seven package archives and 17 total assets. A deliberately altered asset was rejected. The publishing workflow compares the downloaded checksum file to the locally generated original, then verifies every downloaded asset. This local integrity check does not by itself declare those archives a released build.

## Open gates and release status

[Editor validation](editor-validation.md) lists the pending manual visual checks, including JCEF rendering and browser fallback, failure-link clicking, progress/coverage presentation and light/dark readability. The private prerelease workflow deliberately retains prerelease status. Signing/rebasing should happen before tagging the desired release commit; no release tag is created by ordinary CI.

## Reproduce from a fresh checkout

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:vscode
node scripts/extract-vsix.mjs
node scripts/test-bundle.mjs
node scripts/test-vscode.mjs
pnpm package:intellij
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

Use `xvfb-run -a` for the VS Code test on headless Linux. The editor profile/game are disposable, and diagnostics are copied to `dist/test-results/editor` before cleanup. `BRANCHLIGHT_EXTENSION_PATH` can select another extracted extension, and `BRANCHLIGHT_VSCODE_EXECUTABLE` can select an isolated editor installation. Native product selection is `-PplatformProduct=idea`, `webstorm` or `pycharm`.

All CI jobs build from fresh checkouts with frozen pnpm dependencies. Local fresh-checkout verification uses a separate clone with its own dependency installation; no build reads either old project or the ChatGPT workspace. Native builds may reuse downloaded toolchain/IDE caches. Offline installation is not claimed. Python is not a build requirement; maintenance scripts use `uv`.
