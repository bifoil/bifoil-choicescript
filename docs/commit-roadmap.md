# Commit roadmap toward 0.1.0

The eight planned implementation steps are now represented by commits on `main`, with an additional focused Windows URI fix discovered by the platform matrix. The acceptance criteria below remain the release checklist: automated implementation does not mark the manual visual gates as passed. The existing validation baseline is documented in [validation.md](validation.md). Keep the repository private and retain the independent-project notices and unmodified, pinned ChoiceScript engine throughout.

Use one reviewable concern per commit. If a regression exposes a bug, put the regression and its fix together in a focused commit before continuing. Do not rewrite the initial history to imply these checks already existed.

## 1. `ci: test packaged extensions across all six targets`

Change the CI smoke tests to extract each freshly built VSIX and load that extracted extension through `BRANCHLIGHT_EXTENSION_PATH`. Make the bundled-runtime smoke test accept the extracted server/runtime paths rather than only `dist/server`. Use isolated editor profiles and preserve logs and test reports on failure. Run Windows, macOS, and Linux on x64 and ARM64; explicitly record unavailable runner capacity instead of treating a skipped target as passed.

Done when all six target installers launch their bundled server and run the required dialogue fixture, preview, QuickTest, seeded RandomTest, and export on their actual OS/CPU. A successful packaging job alone is insufficient.

## 2. `test(core): expand differential language regressions`

Extend the comparisons against the pinned interpreter for combinations of arrays, indirect references, interpolation, multireplace, escaped quotes, and malformed expression recovery. Add reproducible bounded mutation cases around conditional dialogue and runtime control-flow restrictions. Distinguish parser errors from restrictions that only QuickTest or execution can establish.

Done when the corpus has explicit expected classifications and diagnostics, the interpreter comparisons pass, and both runtime outcomes of the required dialogue fixture remain correct. Any parser or analyzer fixes should be separate focused commits paired with their failing cases.

## 3. `test(lsp): cover concurrent edits and project invalidation`

Exercise the real server with rapid changes while analysis is running, edits to referenced scenes, open/close transitions, file creation/deletion, configuration changes, and multiple games in the same workspace. Assert that completion, rename, diagnostics, and semantic tokens correspond to the latest snapshot and correct project.

Done when obsolete workers cannot publish results, dynamic references are not guessed during rename, and unrelated text files remain unassociated. Include a large-project cancellation case with a generous bounded timeout.

## 4. `test(tooling): verify packaged job cleanup across platforms`

Run the packaged game tools with unsaved buffers, spaces and Unicode in paths, cancellation, rapid restart, editor shutdown, process failures, and export collisions. Inspect job events, saved output, source locations, coverage, and stale-result flags. Extend existing integration tests where possible instead of duplicating their current successful cases.

Done when owned child processes and disposable staging directories are cleaned up, snapshot content is consistent, existing destination files are preserved, and subsequent jobs can run after a failure. Verify these behaviors on Windows and Unix process models.

## 5. `refactor(intellij): reduce deprecated integration API usage`

Replace the avoidable deprecated dialog and text-attribute calls reported by Plugin Verifier. Investigate generated ToolWindowFactory bridges separately; document unavoidable inherited or experimental API use with the exact supported platform baseline. Preserve theme-derived colors and bold/italic modifiers.

Done when native tests and Plugin Verifier still pass, the avoidable warnings are removed, and remaining warnings have a specific rationale. Do not suppress verification failures or promise that experimental APIs are stable.

## 6. `ci(intellij): verify the supported IDE product matrix`

Declare an explicit set of supported JetBrains products and minimum builds with native LSP support, then configure Plugin Verifier and launch checks for that set. Include bundled-runtime startup, project detection, language features, and trust behavior. Keep broader products/builds described as unverified until checked.

Done when every advertised product/build has a passing verifier result and launch evidence, and incompatible products are excluded by the plugin descriptor. Retain IDEA 2026.1.4 as the tested minimum baseline unless an intentional compatibility change is made.

## 7. `test(editors): validate preview and authoring workflows`

Exercise VS Code webview and JetBrains JCEF preview, restart/stop, browser fallback, clickable failures, cancellation, saved output, and coverage presentation through the editor actions. Check project creation, snippets/live templates, indentation, comments, formatting shortcuts, and word counts. Record manual visual checks for light/dark themes where automation cannot establish readability.

Done when both adapters have matching behavior for their shared features and the recorded checks identify the exact editor and platform versions. Keep semantic token parity assertions alongside the visual checks.

## 8. `build: prepare verified private release artifacts`

Add a manually triggered release workflow that builds from a clean checkout, runs the acceptance checks, and produces six VSIX files plus the universal JetBrains ZIP with checksums and dependency notices. Update installation instructions, the validated support matrix, and release notes using actual run results. Attach build products to a private GitHub release rather than committing runtime binaries or IDE caches to Git.

Done when a fresh checkout reproduces the package contents without either old repository, artifact hashes are checked after upload, and all advertised targets have passed their gates. Mark the release as a prerelease while any required platform or UI validation remains open. Marketplace publication remains outside this roadmap.

## Implemented sequence and remaining gates

The commits add extracted-package CI, differential regressions, LSP invalidation fixes, tooling cleanup, IntelliJ API maintenance, three-product native CI, editor workflows and private prerelease packaging. See [validation](validation.md) for executed results. The Windows follow-up reconciles URI encodings and drive-letter casing, preventing unsaved buffers from being analyzed alongside stale disk copies.

The release workflow is ready to run after signing the desired source history. It requires all nine CI jobs, uploads seven installers plus notices/provenance, downloads them again and verifies hashes. No release tag is created during ordinary implementation commits. Manual visual/JCEF/browser/progress checks in [editor validation](editor-validation.md) remain open, so publication stays private and marked as a prerelease.

## Dependencies and workflow

Start with commit 1 so later work receives useful platform feedback. Commits 2–4 strengthen the shared service and game tooling. Commit 5 precedes the wider native verification in commit 6. Commit 7 closes the interactive acceptance gaps; commit 8 follows the completed checks and records their evidence. Any repository or runner limitations should be stated plainly rather than converted into passing results.

The baseline already includes shared parsing/analysis, both adapters, game tools, six-target packaging, 30 passing shared tests, four native tests, Windows/Linux x64 packaged editor checks, and an IDEA 2026.1.4 Plugin Verifier pass. The roadmap expands and validates that implementation; it is not a proposal to rebuild it.
