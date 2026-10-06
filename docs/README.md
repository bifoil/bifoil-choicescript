# Documentation

Bifoil ChoiceScript is an unofficial ChoiceScript authoring environment for VS Code and JetBrains IDEs.
These guides describe the current prerelease implementation. Read [known limitations](known-limitations.md) alongside
feature descriptions; declared support and release acceptance are different things.

## Write your first game

1. [Installation](support.md): choose a package, install it, and confirm activation.
2. [First game](getting-started.md): create a small playable story, test it, and export it.
3. [Authoring guide](usage.md): completion, navigation, snippets, markup, and word counts.
4. [Game tools](game-tools.md): snapshots, preview, deterministic testing, coverage, and export.

## Work with an existing game

- [Projects and files](projects.md): discovery, engine layouts, multiple games, assets, and file association.
- [Configuration](configuration.md): every project key, editor setting, theme category, and command identifier.
- [Language behavior](specification.md): expressions, narrative quotes, control flow, inferred types, and recovery.
- [Diagnostics](diagnostics.md): error codes, narrative warnings, and test failures.
- [Troubleshooting](troubleshooting.md): symptoms, remedies, logs, and useful bug reports.
- [Data and execution](data-and-execution.md): workspace trust, staging, local servers, and exported files.

## Understand the current limits

- [Known limitations](known-limitations.md): actionable gaps and workarounds.
- [Performance and scale](performance.md): memory and latency targets, present limits, and measurement requirements.
- [JetBrains compatibility](jetbrains-compatibility.md): product builds, runtimes, and exclusions.
- [Candidate notes](release-notes.md): scope of the current unreleased version.

## Contribute or integrate

- [Contributing](../CONTRIBUTING.md): setup, contribution scope, and review expectations.
- [Development](development.md): repository map, commands, generated files, and change recipes.
- [Architecture](architecture.md): data flow, core analysis, snapshots, workers, and adapters.
- [Protocol](protocol.md): standard LSP capabilities, custom methods, job lifecycle, events, and errors.
- [Testing](testing.md): focused tests, installed-package checks, native editor checks, and manual acceptance.
- [JetBrains implementation notes](jetbrains-api-notes.md): platform lifecycle, threading, and transport contracts.
- [Packaging and releases](releasing.md): host packages, universal bundles, provenance, and release gates.

[Third-party notices](../THIRD_PARTY_NOTICES.md) explain the engine/runtime provenance and distinct licenses.
The [Gradle dependency inventory](provenance/gradle-linux-x64.xml) records one resolution environment; it is not a
cross-platform compatibility certificate or portable dependency lock.

## Reading conventions

Commands run from the repository root unless a guide says otherwise. Paths in examples are portable placeholders.
ChoiceScript examples use spaces for indentation and directives without trailing colons. Configuration examples are
strict JSON. The guides distinguish editor diagnostics from the official engine's test output.

Public documentation contains original examples and reproducible procedures. Private game corpora, local audit evidence,
transcripts, machine-specific paths, and generated logs are not prerequisites for these guides.

## Code-level documentation

API and lifecycle contracts are documented in the source with JSDoc and KDoc and appear in editor documentation hovers.
Useful starting points:

| Contract                                                                  | Source                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| UTF-16 positions, semantic spans, abstract values, full/compact documents | [Core types](../packages/core/src/types.ts)                                                         |
| Branch/call state, worklist convergence, narrative transfer               | [Project analysis](../packages/core/src/analysis.ts)                                                |
| Job requests, events, readiness, and completion                           | [Shared protocol](../packages/protocol/src/index.ts)                                                |
| Compressed indexes, buffer ownership, incremental updates                 | [Server snapshots](../packages/server/src/snapshots.ts)                                             |
| Staging, child ownership, cancellation, and cleanup                       | [Tool runner](../packages/tooling/src/runner.ts)                                                    |
| Native session lifecycle and reflected notifications                      | [JetBrains integration](../editors/intellij/src/main/kotlin/dev/bifoil/choicescript/Integration.kt) |
| Editor progress, events, and command options                              | [VS Code adapter](../editors/vscode/src/extension.ts)                                               |

See [documentation conventions](development.md#maintain-code-documentation) when changing these contracts.
