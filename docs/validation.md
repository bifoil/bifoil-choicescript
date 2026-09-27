# Validation record — 0.1.0 candidate

Local validation performed on 2026-09-27. This is a working implementation and packaged release candidate; the complete platform acceptance matrix has not yet passed. CI is configured but has not been run remotely.

## Shared implementation

`pnpm check` passes: vendored engine verification, build, TypeScript checking, and **30 tests**. The tests include the required dialogue fixture, independently inherited conditional states, nested alternatives, elseif and missing else, branch-opened quotes, comments between alternatives, malformed expression strings, paragraph continuation, scene transitions, subroutines and recursion, uncertain destinations, flow-sensitive types, arrays and indirect references, local scope, interpolation, multireplace, markup, UTF-16/CRLF, indentation recovery, incremental edits, and a 100-scene/6,000-line graph.

Real LSP subprocess tests cover token publication and replacement-buffer diagnostics. Official-engine integration tests cover project creation, QuickTest, deterministic seeded RandomTest, available coverage, both male/female outcomes of the dialogue fixture, snapshot preview, HTML export, cancellation, trust refusal, and stale results. Temporary project paths include spaces and Unicode. The original 69 vendored files match the pinned upstream archive and their recorded checksums; no engine source is patched.

A separate copy containing the repository's authored inputs builds and passes the shared checks without reading either old checkout or the ChatGPT workspace. Kotlin compilation, native tests, packaging, and Plugin Verifier also run from that independent copy. Downloaded dependency caches are reused; offline installation is not claimed.

## Editor and packaged-runtime checks

- VS Code 1.109.0: real extension-host smoke tests on Linux x64 and Windows x64, loading the extracted final VSIX contents in isolated VS Code 1.109.0 hosts. The tests activate the adapter, detect scene files without claiming unrelated text, inspect the required fixture's dialogue and expression classifications, check absence of quote warnings, and exercise completion, definition, and rename. Token checks run with both Default Dark Modern and Default Light Modern themes.
- IntelliJ IDEA 2026.1.4, build 261.26222.65: **4 native tests pass**. These cover the fallback lexer, physical-line string recovery, PSI language detection, light/dark theme-derived semantic attributes and bold/italic modifiers, and launch of the packaged Node/LSP server with the required dialogue fixture. This is platform integration testing, not a manual IDE walkthrough.
- JetBrains Plugin Verifier 1.410 reports **Compatible** against IntelliJ IDEA 2026.1.4. Its report includes six deprecated-API and six experimental-API usages; these are compatibility maintenance risks, not reported binary incompatibilities. Reports are generated under `editors/intellij/build/reports/pluginVerifier`.
- Bundled Node 24.21.0 executes the real server, preview, QuickTest, RandomTest, and export on Windows x64 and Linux x64 without using system Node for those operations.
- All six VSIX targets are generated. Their runtime hashes match the official archive lock, their server/worker bundles match the built shared implementation, and the engine and dependency notices are present. The universal JetBrains ZIP contains the same server plus all six checksummed runtime resources. Archive integrity does not establish execution compatibility on an untested host.

## Remaining release gates

- Execute the packaged extensions and game tools on macOS x64/ARM64, Linux ARM64, and Windows ARM64. Run the configured CI matrix and investigate any failures before treating those targets as validated.
- Run Plugin Verifier and launch tests for each additional JetBrains product/build advertised as compatible. The local result covers IntelliJ IDEA 2026.1.4 only; the plugin requires the native LSP module.
- Manually check JetBrains light/dark color rendering and embedded JCEF preview, and both editors' interactive preview/restart/browser fallback and cancellation UI. Automated semantic-token tests do not establish visual readability or every UI interaction.

## Reproducing checks

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:vscode
node scripts/test-bundle.mjs
node scripts/test-vscode.mjs
pnpm package:intellij
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

Use `xvfb-run -a` for the VS Code smoke test on headless Linux. `BRANCHLIGHT_EXTENSION_PATH` can point to an extracted VSIX's `extension` directory to test the actual packaged contents. The Windows CommonJS launcher is `scripts/test-vscode-native.cjs`; it also accepts `BRANCHLIGHT_VSCODE_EXECUTABLE` for an isolated downloaded host. These are development checks; installed users do not need Node, pnpm, Java development tools, or Python.

VSIX checksums are in `dist/packages/SHA256SUMS.txt`; the JetBrains ZIP checksum is beside its distribution. Build artifacts, IDE downloads, and test caches are ignored by Git.
