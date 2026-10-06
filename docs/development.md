# Development guide

Start with [Contributing](../CONTRIBUTING.md#build-from-source) for prerequisites and checkout setup.
All commands here run from the repository root. The build must work without sibling Bifoil projects, old ChoiceScript
checkouts, or private local reports.

## Toolchain

| Tool                       | Declared use                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ |
| Node.js                    | Major 24; packaged runtime and CI pin are in `runtime-lock.json` and workflows |
| pnpm                       | Exact version in `package.json#packageManager`                                 |
| TypeScript / tsx / esbuild | Type checking, source-test execution, bundles                                  |
| JDK 21                     | JetBrains Gradle toolchain                                                     |
| Gradle wrapper             | Checked-in wrapper under `editors/intellij`                                    |
| Kotlin                     | Version declared in `editors/intellij/build.gradle.kts`                        |
| Python / uv                | Optional development scripting only; Python is not required to build           |

The package manager and runtime pins should be read from source when upgrading; installing whatever happens to be
latest can produce an unreproducible environment. Preserve lockfiles and explicit dependency script permissions.

## Repository map

| Path                                                  | Purpose                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `packages/core/src/parser.ts` / `expression.ts`       | Indentation and expression parsing                              |
| `packages/core/src/analysis.ts`                       | Dialogue/type flow, symbols, semantic classifications           |
| `packages/core/src/features.ts`                       | Language feature queries                                        |
| `packages/core/src/projection.ts`                     | Compact closed-scene representation                             |
| `packages/core/src/commands.json`                     | Command descriptions and shared generation input                |
| `packages/server/src/index.ts`                        | LSP transport, scheduling, revisions, publication, job requests |
| `packages/server/src/worker.ts`                       | Background analysis and index construction                      |
| `packages/server/src/scene-index.ts` / `snapshots.ts` | Scene inventory/cache and compact request data                  |
| `packages/protocol/src`                               | Wire contracts, validation, coverage state, runtime policy      |
| `packages/tooling/src/projects.ts`                    | Detection and source enumeration                                |
| `packages/tooling/src/runner.ts` / `processes.ts`     | Jobs, staging, child processes, preview, cleanup                |
| `editors/vscode/src`                                  | Extension adapter                                               |
| `editors/intellij/src/main`                           | Kotlin adapter, resources, plugin descriptor                    |
| `fixtures`                                            | Small original game fixtures                                    |
| `vendor/choicescript`                                 | Unmodified pinned engine submodule                              |

Package tests live beside their packages under `test/`. Native Kotlin tests live under
`editors/intellij/src/test`. Editor smoke tests live under `editors/vscode/test`.
The [architecture guide](architecture.md) explains how these parts interact.

## Build and check commands

| Command                           | What it does                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm generate`                   | Regenerate shared editor metadata/fallback artifacts                                  |
| `pnpm build`                      | Verify engine, generate, bundle JavaScript, copy engine/notices and adapter resources |
| `pnpm typecheck`                  | Run TypeScript checking without emitting                                              |
| `pnpm test`                       | Run protocol/core/tooling/server tests through tsx                                    |
| `pnpm check`                      | Build, then typecheck, then tests                                                     |
| `pnpm test:corpus <paths>`        | Read-only static analysis of explicitly supplied local source                         |
| `pnpm runtime`                    | Provision the current host's pinned Node runtime                                      |
| `pnpm package:vscode`             | Package a host-target VSIX from built outputs                                         |
| `pnpm package:intellij --current` | Prepare host runtime/server resources for Gradle                                      |
| `pnpm format`                     | Format the source/XML/SVG globs declared in package.json                              |

Build before tests that launch `dist/server/server.cjs`. Package commands consume build outputs; they are not a
substitute
for rebuilding after edits. See [packaging](releasing.md) for target arguments.

For one regression file:

```sh
node --import tsx --test --test-isolation=none packages/core/test/core.test.ts
```

Choose the file relevant to your change. A focused pass does not imply all package tests passed.

## What build generates

`scripts/build.mjs` verifies the engine pin and hashes, runs generation, bundles the server/analysis worker and VS Code
adapter, copies the runtime inventory, and writes notices.
It also derives the VS Code package README from the root README, rewriting repository-relative links for distribution.

| Output                                       | Handling                                                  |
| -------------------------------------------- | --------------------------------------------------------- |
| `dist/server`                                | Built server, worker, engine subset, metadata/notices     |
| `editors/vscode/dist`                        | Built extension                                           |
| `editors/vscode/server` / `runtime`          | Packaged server/runtime copies                            |
| `editors/vscode/README.md` / `LICENSE`       | Generated distribution documents; edit their root sources |
| `editors/intellij/src/main/resources/bundle` | Prepared runtime/server archives and manifest             |
| `dist/packages`                              | VSIX installers                                           |
| `editors/intellij/build/distributions`       | Gradle-built JetBrains ZIP                                |
| `.cache` / `.vscode-test` / Gradle caches    | Reusable downloads and test installations                 |

Some generated grammar/metadata files are tracked. Run `pnpm generate` after metadata changes and inspect the resulting
diff. Do not hand-edit a generated distribution README and expect the next build to retain it.

## Change a language feature

1. Add a small original input and expected ranges/classifications.
2. Update parser or flow semantics in core.
3. Check both a full document and a compact projection if the change affects closed scenes.
4. Exercise the feature through LSP with current revisions and cancellation where relevant.
5. Confirm both adapters can render/use the result without their own semantic reinterpretation.
6. Update [language behavior](specification.md), [diagnostics](diagnostics.md),
   or [known limitations](known-limitations.md).

For quotation changes, include malformed command strings inside open narrative, branch siblings, missing alternatives,
scene transitions, and calls. For type changes, test reassignments, joins, arrays, indirection, and local shadowing.
For range changes, include CRLF and supplementary Unicode.

## Add or change a command

Edit `packages/core/src/commands.json` to update command documentation and generated metadata, then update parsing and semantic behavior if the
command needs it. Metadata recognition alone does not implement runtime semantics or argument validation.
Regenerate the fallbacks and add targeted tests of both parsing and the editor-facing result.

Keep references aligned with the pinned engine. A newer upstream command is not automatically available in the bundled
runtime. Hosted/purchase/service commands may be recognized without the local preview providing those services.

## Change a tooling operation

Update the shared protocol and validation first, then the runner, server dispatch, and both adapters.
Test success, invalid options, cancellation before and after child start, concurrent requests, stale results, output
mapping, cleanup, and destination collisions as applicable.
Install a notification listener before starting jobs in tests.

Use a temporary original game. Never rely on a private source corpus or mutate the pinned engine to make a test pass.
The export compatibility preload belongs in staging, not upstream source.

## Work on JetBrains

After the shared build:

```sh
pnpm package:intellij --current
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

On Windows without Bash, invoke `editors/intellij/gradlew.bat -p editors/intellij test buildPlugin verifyPlugin`.
IDEA is the default; `-PplatformProduct=webstorm` and `-PplatformProduct=pycharm` select the other declared baselines.

Resource preparation is not a ZIP build. Native test success is not proof that the live platform's LSP manager,
callbacks,
preview, and UI behave correctly. Read [JetBrains implementation notes](jetbrains-api-notes.md).

## Inspect failures without accumulating artifacts

Start with the failing command and its own output. Use the [troubleshooting guide](troubleshooting.md) to distinguish
engine hash failures, dependency-script blocks, stale bundles, runtime mismatch, and analysis failure.

Reuse downloaded runtimes and SDKs. Avoid all-platform packaging for a one-host code change. Keep local reports under
ignored `.bifoil-choicescript/development/` and remove only obsolete output you own after processes exit.
Do not blindly clear shared package-manager caches, IDE installations, or a user's game export directory.

A fresh checkout should need only declared dependencies and the pinned submodule. A build that works only because a
private staging directory or an old checkout exists is a build defect.

## Maintain code documentation

Public TypeScript contracts use JSDoc and Kotlin integration points use KDoc. Read them in the source or through the editor's
Quick Documentation or hover UI. There is no separate generated API website or documentation build dependency.

Document units (especially UTF-16 positions and zero-based lines), ownership and mutation, omitted/partial data,
event ordering, cancellation, errors, and resource lifetimes. Explain why an invariant matters rather than paraphrasing
each assignment. Private helpers need comments where their assumptions protect correctness or performance.

Keep comments aligned with behavior: an attempted cleanup is not guaranteed removal, a heap limit is not total RSS,
and a start acknowledgement is not a completed test. Do not describe a known broken native transport path as accepted.
Update relevant API comments together with implementation and protocol changes.

For documentation-only code edits, check syntax/types and compare the executable structure against the pre-edit source.
Avoid introducing behavior changes or reformatting unrelated Kotlin while adding KDoc.
