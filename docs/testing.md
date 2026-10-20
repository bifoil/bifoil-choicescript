# Test a plugin change

This is the contributor test guide. To test a story, use [game tools](game-tools.md). Set up dependencies through
[Contributing](../CONTRIBUTING.md#build-from-source). Commands run from the repository root.

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
go test ./packages/core/src ./native/server
go test -race ./packages/core/src ./native/server
go vet ./packages/core/src ./native/server
pnpm check
```

The Go commands test the installed native language implementation. `pnpm check` verifies the engine pin,
generates/bundles code with the pinned installed Go SDK, checks TypeScript, and runs the package regression/integration
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

The command statically analyzes supplied sources without copying them into the repository or executing game code. If no
project is found, a supplied directory can be treated as explicitly selected scene fragments. JSON output includes
summaries; `--details` includes relative locations/messages.

Each directory uses a separate process with a **1 GiB V8 heap limit** and a **60-second timeout**. This reference TypeScript
diagnostic harness does not exercise the installed native backend or its 256 MiB combined-runtime acceptance budget. Errors, invalid ranges, truncated
analysis, or worker failures fail the run; narrative warnings alone do not.

Use only sources you are authorized to access and keep source names/text and reports out of committed docs and fixtures.

## Packaged VS Code checks

After shared checks:

```sh
pnpm package:vscode
node scripts/extract-vsix.mjs
node scripts/test-bundle.mjs
node scripts/test-vscode.mjs
```

Extraction checks the host target, native source/binary/license hashes and bundled runtime provenance, writes an installed-extension pointer, and retains an
extracted package under `.cache/installed/`. The tests use that package, an isolated profile, and temporary game source.

The editor harness defaults to VS Code **1.109.0** and can download it. To use an existing installation, set
`BIFOIL_CHOICESCRIPT_VSCODE_EXECUTABLE` to its executable. `BIFOIL_CHOICESCRIPT_EXTENSION_PATH` selects an explicitly
extracted extension. Using another version does not validate the minimum version.

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

`ChoiceIntegrationTest` covers the descriptor and direct LSP4J transport. `ChoiceManagerTest` additionally opens an actual
project file through the IDE client manager and asserts document synchronization, the real custom notification receiver
and current hover. `ChoiceScaleTest` generates an original disposable 20-million-word game and exercises all scenes and
current edits through that same manager with a one-second interaction deadline. These checks do not measure pixel paint
or establish every native UI path. Retain manual acceptance for presentation, previews and coverage behavior.

See [compatibility](jetbrains-compatibility.md) and [implementation notes](jetbrains-api-notes.md).

## Manual acceptance

Install the built package, open `fixtures/dialogue`, and check the required dialogue fixture in both editors. Change
gender so both runtime alternatives execute.

Then verify:

- Commands retain expression colors inside open dialogue; following prose returns to ordinary narrative styling.
- Light/dark schemes, modifier styles, and readable coverage decorations.
- Completion, hover, definitions, references, rename preview, symbols, folding, selection, comments, and markup actions.
- Game detection without claiming unrelated text files, including multiple games and spaces/Unicode in paths.
- Preview choices, browser fallback, explicit restart, stop, and closing the project.
- Unsaved buffers, current diagnostics, stale results, clickable failures, seeds, coverage, and cancellation.
- Exported HTML and companion assets, collisions, partial failure, and process/temp cleanup.

An unavailable/locked desktop or failed automation session leaves visual checks unverified. Report known defects as
failures or limitations, not passed checks with omitted assertions.

## Performance and large games

The server performance suite and `scripts/benchmark-large-game.mjs` are described in
[performance and scale](performance.md), including their measurement gaps. Acceptance includes native editors and games
with tens of millions of words. A no-op edit, timeout, stale response, worker crash, or placeholder does not satisfy
response latency.

Sample combined owned-process RSS while tools and analysis run concurrently. Line count alone, Node heap size, or the
full IDE JVM's memory is not the required measurement.

## Coverage collection

Coverage includes the original shared core, native server, reference server, game tools, both adapters and build scripts.
Generated binary data and the unmodified upstream engine are outside this scope. Tests must assert observable behavior;
executing a line without checking its result is not sufficient regression protection.

The project quality gate requires at least 90% overall coverage and 90% coverage on new code, with no more than 1%
duplication overall or on new code. Coverage combines executable lines and branch conditions; individual languages and
line-only percentages are separate measures.

Build first, then collect JavaScript and TypeScript coverage:

```sh
pnpm build
pnpm test:coverage
```

The runner compiles functional tests with source maps and collects V8 counters from the test process and its Node children.
The pinned c8/Monocart mapper reports original source locations. A separate probe verifies that an unexecuted function and
branch body remain uncovered. Original module URLs preserve fixture and resource lookup in compiled tests. Reports under
`dist/coverage/` are ignored; `javascript.lcov` is the normalized Sonar input. Mapping warnings are saved explicitly rather
than assigned invented source locations.

Installed-runtime packaging checks are opt-in. Set `BIFOIL_TEST_PACKAGING=1` before collecting coverage to exercise current
host IntelliJ archive preparation and server-only refresh. Prepare or cache the host runtime first to avoid a download.
These checks verify archive hashes, inclusion of the native server, omission of source maps and preservation of the Node
archive during a server-only refresh. They produce local build resources without publishing a release.

Collect native Go coverage with the pinned SDK. Set `BIFOIL_TEST_NODE` to an absolute Node executable so broker integration
checks run on hosts where Node is not on `PATH`:

```sh
go test -coverpkg=./packages/core/src,./native/server \
  -coverprofile=dist/coverage/go-host.out ./packages/core/src ./native/server
node scripts/merge-go-coverage.mjs dist/coverage/go.out dist/coverage/go-host.out
```

Collect each platform from the same source revision. Additional profile paths can follow the first input to union hits
across platforms. The merger validates source blocks and never averages percentages. A matching block layout cannot
prove identical source bytes: retain source hashes with reports and regenerate profiles after production edits. Native
entry-point tests launch the instrumented test executable as a real subprocess; Go merges its actual coverage counters.

For the original C arena, a Linux x64 host can collect LLVM coverage using an installed, matched set of `clang`,
`llvm-profdata` and `llvm-cov`:

```sh
BIFOIL_LLVM_BIN=/absolute/path/to/llvm/bin pnpm test:coverage:c
```

This runs the unchanged arena algorithm through a small native WebAssembly ABI shim, then writes LCOV and Sonar generic
coverage XML. The shim uses low addresses for the arena's 32-bit pointers. It does not establish coverage of the
WebAssembly engine itself; the independent JavaScript map-oracle tests still execute the shipped WebAssembly binary.

Prepare JetBrains host resources, then enable JaCoCo explicitly:

```sh
pnpm package:intellij --current
bash editors/intellij/gradlew -p editors/intellij -Pcoverage=true test jacocoTestReport
bash editors/intellij/gradlew -p editors/intellij -Pcoverage=false test --tests '*ChoiceScaleTest'
```

Use `gradlew.bat` on Windows. Coverage runs omit the strict scale timing test; the following uninstrumented command runs
that test with its original one-second deadline. JavaScript latency checks likewise run separately without coverage.
Coverage agents and development test processes are not evidence of the installed runtime's memory or latency acceptance.

[Sonar scanner settings](../sonar-project.properties) import the JavaScript LCOV, merged Go profile, LLVM generic XML and
JaCoCo XML. Use a full branch analysis when evaluating overall coverage; changed-file views alone cannot establish the
whole-project percentage. Local report generation does not update SonarQube Cloud until an authenticated scanner imports
those reports. Preserve the distinction between an analyzed working tree and the committed default branch.

## CI and results

[Build and verify](../.github/workflows/ci.yml) runs shared builds, type checks, and tests on six OS/architecture
combinations, plus native tests against three JetBrains products, on pushes and pull requests. Native tests prepare
only the runner's bundled runtime resources; routine runs do not build or upload installers.

To exercise packaging, bundled-runtime smoke tests, VS Code execution, and Plugin Verifier, manually dispatch the
workflow with `build_packages` enabled. The private prerelease workflow enables that input automatically. Package runs
upload six VSIX files and the IDEA-built ZIP for one day. WebStorm and PyCharm installers are verified without uploading
duplicate ZIPs. Failing jobs can upload diagnostics for seven days; successful routine runs upload no artifacts.

Workflow configuration is not evidence of a successful current run; inspect the jobs for the revision being reviewed.

In the change report, list the commands and platforms actually checked, failures, and remaining unverified dimensions.
Keep detailed local output in ignored `.bifoil-choicescript/development/`. Publication has its own
[release gates](releasing.md).
