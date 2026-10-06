# Test a plugin change

This is the contributor test guide. To test a story, use [game tools](game-tools.md).
Set up dependencies through [Contributing](../CONTRIBUTING.md#build-from-source).
Commands run from the repository root.

## Choose the check that answers the question

| Check                              | Establishes                                             | Does not establish                                    |
| ---------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| Type checking                      | TypeScript API/type consistency                         | Runtime or editor behavior                            |
| Core regression                    | Semantics and ranges on its examples                    | Every engine construct or large game                  |
| LSP integration                    | Server/client wire behavior under the harness           | Native editor UI delivery                             |
| Tooling integration                | Staging and official job behavior on tested games       | Arbitrary workload capacity or hostile-code isolation |
| Extracted-bundle smoke             | Packaged runtime/server can execute the tested workflow | Full editor compatibility                             |
| Native adapter test                | Tested platform classes/helper integrations work        | All native manager/transport paths                    |
| Plugin Verifier                    | API compatibility against selected IDE builds           | Correct notifications, theme rendering, or latency    |
| Manual installed-plugin acceptance | Observed workflows in a real editor session             | Other platforms or untested workloads                 |

Record the artifact and revision tested. Rebuild and repackage after source changes before using installed-package
results as evidence about that change.

## Shared checks

```sh
pnpm check
```

This verifies the engine pin, generates/bundles code, checks TypeScript, and runs the package regression/integration
suites. It can execute official tools on original temporary games.

For focused work:

```sh
pnpm build
node --import tsx --test --test-isolation=none packages/core/test/core.test.ts
```

Use the affected test file. Pure source tests may not need a rebuild; server/bundle tests that launch generated code do.
Run additional suites when the change or a failure warrants them, rather than repeatedly rerunning unchanged checks.

## Regression design

Use small original inputs and assert behavior, not only “did not crash.”

| Area             | Important cases                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Quotes           | Both branches, nested alternatives, `*elseif`, missing `*else`, quotes opened inside branches |
| Recovery         | Unterminated command strings inside open dialogue, malformed interpolation, later commands    |
| Flow             | Jumps, scenes, subroutines, recursion, unreachable continuations, unknown destinations        |
| Types            | Reassignment, branch joins, coercion, arrays, indirection, deletion, shadowing                |
| Ranges           | CRLF, escaped quotes, supplementary Unicode, nonoverlapping tokens                            |
| Incremental work | Different text on every edit, current versions, projection/full-analysis agreement            |
| Tooling          | Trust, invalid options, open buffers, collision preservation, failures, cancellation, cleanup |
| Adapters         | Real transport payloads, project selection, UI settlement, light/dark styles, coverage        |

Add regressions in package tests or `fixtures/`. Public docs may explain examples but are not a store of private corpus
results or audit evidence.

## Analyze local scenes without execution

```sh
pnpm test:corpus "/path/to/game"
pnpm test:corpus --details "/path/to/game" "/path/to/scene-fragments"
```

The command statically analyzes supplied sources without copying them into the repository or executing game code.
If no project is found, a supplied directory can be treated as explicitly selected scene fragments.
JSON output includes summaries; `--details` includes relative locations/messages.

Each directory uses a separate process with a **1 GiB V8 heap limit** and a **60-second timeout**.
This diagnostic harness does not use the production 256 MiB combined-runtime acceptance budget.
Errors, invalid ranges, truncated analysis, or worker failures fail the run; narrative warnings alone do not.

Use only sources you are authorized to access and keep source names/text and reports out of committed docs and
fixtures.

## Packaged VS Code checks

After shared checks:

```sh
pnpm package:vscode
node scripts/extract-vsix.mjs
node scripts/test-bundle.mjs
node scripts/test-vscode.mjs
```

Extraction checks the host target and bundled runtime provenance, writes an installed-extension pointer, and retains an
extracted package under `.cache/installed/`. The tests use that package, an isolated profile, and temporary game source.

The editor harness defaults to VS Code **1.109.0** and can download it. To use an existing installation, set
`BIFOIL_CHOICESCRIPT_VSCODE_EXECUTABLE` to its executable.
`BIFOIL_CHOICESCRIPT_EXTENSION_PATH` selects an explicitly extracted extension.
Using another version does not validate the minimum version.

On headless Linux:

```sh
xvfb-run -a node scripts/test-vscode.mjs
```

Editor reports are under `dist/test-results/editor`. The harness removes its temporary profile but retains reports and
package/test caches. A GUI smoke test still needs assertions of the relevant user-visible behavior.

## JetBrains checks

After `pnpm build`, prepare a host-local bundle:

```sh
pnpm package:intellij --current
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

Windows command:

```powershell
editors/intellij/gradlew.bat -p editors/intellij test buildPlugin verifyPlugin
```

IDEA is the default. Add `-PplatformProduct=webstorm` or `-PplatformProduct=pycharm` for another declared product.
Release validation prepares all runtime resources and checks all three products; avoid those large downloads for
unrelated local changes.

The existing integration test directly creates a descriptor/process/LSP4J connection for parts of its coverage.
That is useful but does not prove the real IDE LSP manager invokes every callback correctly.
Exercise the native manager and notification delivery in an actual IDE session for changes to discovery, DTOs,
coverage, startup, and disposal.

See [compatibility](jetbrains-compatibility.md) and [implementation notes](jetbrains-api-notes.md).

## Manual acceptance

Install the built package, open `fixtures/dialogue`, and check the required dialogue fixture in both editors.
Change gender so both runtime alternatives execute.

Then verify:

- Commands retain expression colors inside open dialogue; following prose returns to ordinary narrative styling.
- Light/dark schemes, modifier styles, and readable coverage decorations.
- Completion, hover, definitions, references, rename preview, symbols, folding, selection, comments, and markup actions.
- Game detection without claiming unrelated text files, including multiple games and spaces/Unicode in paths.
- Preview choices, browser fallback, explicit restart, stop, and closing the project.
- Unsaved buffers, current diagnostics, stale results, clickable failures, seeds, coverage, and cancellation.
- Exported HTML and companion assets, collisions, partial failure, and process/temp cleanup.

An unavailable/locked desktop or failed automation session leaves visual checks unverified.
Report known defects as failures or limitations, not passed checks with omitted assertions.

## Performance and large games

The server performance suite and `scripts/benchmark-large-game.mjs` are described in
[performance and scale](performance.md), including their measurement gaps.
Acceptance includes native editors and games with tens of millions of words.
A no-op edit, timeout, stale response, worker crash, or placeholder does not satisfy response latency.

Sample combined owned-process RSS while tools and analysis run concurrently.
Line count alone, Node heap size, or the full IDE JVM's memory is not the required measurement.

## CI and results

[Build and verify](../.github/workflows/ci.yml) defines six VS Code OS/architecture jobs and three JetBrains product
jobs.
It builds packages and uploads artifacts/diagnostics where available. Workflow configuration is not evidence of a
successful current run; inspect the jobs for the revision being reviewed.

In the change report, list the commands and platforms actually checked, failures, and remaining unverified dimensions.
Keep detailed local output in ignored `.bifoil-choicescript/development/`. Publication has its own
[release gates](releasing.md).
