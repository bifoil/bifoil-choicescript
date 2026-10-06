# Troubleshooting

Start with the symptom, then inspect the relevant output. Reinstalling does not fix an analysis limitation or an invalid
game. Known defects are collected in [known limitations](known-limitations.md).

## A scene is still plain text

1. Confirm the file is under a directory containing lowercase `startup.txt`.
2. Open the game folder as an editor workspace/project, not only an unrelated parent or loose file.
3. Check `choicescript.json` paths if present. A valid config stops discovery below its root even when its scene path
   is wrong.
4. Check the discovery depth and exclusions in [projects](projects.md).
5. Remove an unintended conflicting file association or disable an older duplicate plugin.
6. Save and reload/reopen the workspace if files were moved.

You can explicitly select ChoiceScript for one file to obtain editing assistance. That does not establish a project for
preview/testing or complete cross-scene analysis. Do not globally associate all `.txt` files just to fix one game.

## Colors are missing or surprising

Fallback highlighting is available before semantic analysis. Verify that the language service starts and semantic
highlighting is enabled. In VS Code, inspect `[choicescript].editor.semanticHighlighting.enabled` through normal
settings;
the JSON form is shown in [configuration](configuration.md#vs-code-editing-defaults).

Neutral variables can mean mixed/unknown types. Neutral narrative can mean uncertain incoming quotation.
Both can be correct conservative classifications. A theme may also assign the same color to different categories.

Expression strings must close on their line; dialogue need not. If one malformed command string absorbs later commands,
report that as a bug with a minimal input.
If only one theme looks wrong, include the theme name and semantic category rather than assuming the parser failed.

## Completion is not opening automatically

VS Code quick suggestions are disabled by default for ChoiceScript prose. Invoke completion explicitly after `*`,
inside an expression/substitution, or after a jump command.
The plugin does not supply prose autocomplete. See [authoring](usage.md#completion-and-documentation).

## Hover, references, or rename says the document changed

The request requires a current analysis snapshot. During indexing or rapid edits the server may return
`ContentModified` instead of stale data. Let indexing settle and retry.
Complete-project operations such as references/rename need more context than a local fallback lexer.

Repeated timeouts, worker failures, or unavailable results on a large game are current scale limitations, not a prompt
to increase a nonexistent editor memory setting. Capture a minimal original reproduction or workload description.
Review every rename preview because semantic edge cases remain.

## Stale results or project membership

Test results describe the captured source, not later edits. Rerun after changes.
The current implementation has gaps for configured roots outside workspace watches, directory-only moves/deletions,
and some older job results after history eviction.

Save files, reload/reopen the workspace, confirm the detected project, then rerun.
To start a new preview, invoke **Run Game** again rather than refreshing an old stopped page.
An absent stale badge does not prove the snapshot is current if you edited during startup.

## No coverage appears

First confirm the job completed and emitted coverage, rather than failing during preparation.
Coverage is line execution data, not a guaranteed event for every operation.
Edits can invalidate decorations.

JetBrains currently has a native notification/project-association defect affecting coverage.
There is no settings workaround that makes a broken transport callback reliable.
In VS Code, check that the scene belongs to the tested project and that the active theme makes the executed-line decoration
visible.

## Tooling asks for trust

Preview, project creation, official tests, and export execute tooling and require the editor's workspace trust.
Use the editor's normal trust decision for a project you intend to execute.
Language assistance remains available without it. A client-supplied trust flag is not a way to bypass the editor UI.

## Preview is blank, old, or still visible after stop

Read the Bifoil output/tool window for preparation and launch errors. Check project detection and startup syntax first.
If embedding is unavailable, use the browser fallback.

Preview captures a snapshot and does not hot-reload. Restart to include edits.
Stopping closes the server but cannot terminate JavaScript already loaded in a browser; close that page.
VS Code can leave a stopped panel visible and starting another preview currently closes prior preview panels.

An old browser tab, a game already rendered in memory, and a live preview server are different states.

## QuickTest or RandomTest fails

Inspect the actual output and completion code:

| Observation                 | Next step                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Scene/line failure          | Open that source location in the captured version                                                    |
| Invalid iteration/seed      | Use decimal integers within the [documented bounds](configuration.md#randomtest-defaults-and-ranges) |
| Nested scene error          | Keep runtime scene files directly beside `startup.txt`                                               |
| File changed during copy    | Retry after external writes finish                                                                   |
| Cancelled / code 130        | The run did not complete successfully                                                                |
| Runtime launch error        | Check package host/architecture and runtime presence                                                 |
| Out-of-memory / worker exit | Consult [performance limits](performance.md); this is not proof of a game syntax error               |
| Log-write failure           | Check destination permissions and free disk space                                                    |

Repeat RandomTest with the same source, engine, seed, and count. Do not change the seed before recording a failure you
want reproduced. Preparation or queue cancellation can currently be delayed or presented as an error.

## Export is incomplete or refuses to overwrite

Choose a fresh destination. Existing-file collisions are preserved rather than overwritten, and failed exports can
leave partial new output.

Keep companion assets alongside the HTML in their relative paths. Check that `assets` points at the intended asset root.
Engine-provided fonts have a known export gap; inspect typography in the exported game.
Do not infer asset completeness from compilation success alone.

## A package will not load

| Symptom                        | Check                                                               |
| ------------------------------ | ------------------------------------------------------------------- |
| VSIX runtime cannot execute    | OS/CPU target, actual extension-host environment, bundled runtime   |
| JetBrains plugin incompatible  | Exact baseline build and native LSP module                          |
| JetBrains runtime missing      | Whether the ZIP was prepared with host-only `--current`             |
| Runtime checksum mismatch      | Package integrity and provenance; obtain/rebuild a matching package |
| Old behavior after rebuilding  | Whether you rebuilt, repackaged, and loaded that exact artifact     |
| Duplicate features/diagnostics | An older branded plugin or second ChoiceScript extension            |

Check [installation](support.md) before changing permissions or copying runtime files manually.
A source build alone does not update an installed plugin.

## Dependency installation and source builds

`ERR_PNPM_IGNORED_BUILDS` means pnpm encountered dependency scripts outside the declared permissions.
Use the repository's pnpm version and current `pnpm-workspace.yaml`. Review the dependency and its reason for a build
script before adding explicit permission; do not blanket-approve scripts or carry a stale lock/config from an older
checkout.

For engine revision/checksum failures, inspect:

```sh
git submodule status
git -C vendor/choicescript status --short
node scripts/check-engine.mjs
```

The recorded pin and original bytes must agree. Preserve upstream line endings with the documented
`core.autocrlf=false` checkout procedure. Do not reset an edited submodule or overwrite hash manifests without first
understanding and preserving local work.

Runtime/SDK provisioning can require network access when caches are empty. An offline cache miss is not a parser defect.
Reuse matching downloads; do not replace pinned hashes merely because an archive failed verification.

## Gradle and IDE warnings

Use `--warning-mode all` for detailed Gradle deprecations.
Separate Gradle warnings, Kotlin compiler diagnostics, Plugin Verifier API warnings, and runtime IDE log exceptions.
The native LSP API is experimental, so API-status warnings need symbol-by-symbol review rather than blanket suppression.

`pnpm package:intellij` prepares resources; Gradle creates and verifies the ZIP.
A successful preparation message is not a successful native build.
See [JetBrains compatibility](jetbrains-compatibility.md).

## Find useful logs

- VS Code: Bifoil ChoiceScript output and the editor's extension-host/language-client diagnostics.
- JetBrains: Bifoil ChoiceScript tool window and normal IDE logs.
- Game test/compiler jobs: `<game-root>/.bifoil-choicescript/logs/<job-id>.log`.
- Contributor editor tests: `dist/test-results/editor/`.
- Gradle tests/verifier: the build reports/output for the selected product.

Logs can include story text and filesystem paths. Review before sharing.
The plugin does not cap total saved log storage. Stop relevant jobs before removing obsolete, task-owned output;
do not clear shared SDK/package caches or user game files indiscriminately.

## Reporting a problem

Provide:

1. Plugin version/candidate revision, editor name and exact version, OS and CPU architecture.
2. Expected behavior and what actually happened.
3. A minimal **original or shareable** scene/configuration that reproduces it.
4. Steps from opening the project to the failure.
5. For tools: operation, seed/iterations, whether buffers were saved, job completion status, and a sanitized excerpt.
6. For performance: actual words/bytes, scene sizes/count, command density, open buffers, and measurement scope.

Do not upload an entire private game by default. Replace names/prose with original text while retaining the construct
that triggers the problem. Include whether a real native editor was exercised; a server harness result is a different
reproduction.

Submit through the repository's issue/PR workflow if you have access. There is no separate public support or private
security-reporting channel established by this documentation.
