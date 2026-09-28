# Architecture

Original code lives in four TypeScript packages and two editor adapters. The engine in `vendor/choicescript` is an
unmodified Git submodule with separate licensing. Its Git revision and per-file checksums are verified before builds.
Builds use repository sources and pinned dependencies, and omit Git metadata from bundled and staged engine copies.

`core` parses physical lines into an indentation tree. Expression tokenization has a physical-line recovery boundary.
Narrative quotation uses an independent abstract state propagated through a control-flow graph. Conditional alternatives
inherit the same input; joins union possible quote states. Command literal quotes never toggle narrative state. Calls
use context-indexed summaries and subscribers; recursive summaries converge through a worklist rather than an unbounded
call stack. Abstract variable values retain constants only when incoming paths agree. Mixed types and unknown generated
text lose precision conservatively.

The shared source model uses JavaScript UTF-16 offsets, matching LSP. Semantic spans are split at overlay boundaries so
expression tokens inside prose never overlap dialogue tokens. Native fallback lexers do not attempt cross-line narrative
quotation.

`server` snapshots project files plus open buffers, sends analysis to a worker, terminates superseded workers, and
publishes only the current revision. Editor actions use protocol version 1. Heavy game operations run in subprocesses
rather than the analysis worker.

`tooling` discovers game roots and copies the bundled engine, game assets, and buffer snapshots to a disposable staging
directory. Preview serves only that staged web root on loopback. Test logs are persisted under the game root. Test
diagnostics are mapped back to scene URIs; snapshot results are marked stale after edits. Compilation uses the official
compiler and preserves companion assets.

The VS Code client handles file association, commands, webview preview, settings, and semantic theme mappings. The
Kotlin client uses the native JetBrains LSP API, a project-aware language substitutor, color settings, live templates,
and a JCEF tool window. Packaged clients use checksum-verified Node runtimes. The IntelliJ plugin extracts its verified
resources into the IDE cache.

## Protocol

Standard LSP handles editing features. `choicescript/projects` returns detected projects. `choicescript/job` accepts the
versioned `JobRequest` type and returns a job handle; `choicescript/jobEvent` streams state, logs, diagnostics,
coverage, and completion. `choicescript/projectsChanged` updates project discovery. `choicescript/wordCount` reports
narrative word count. TypeScript contracts live in `packages/protocol`; Kotlin DTOs and contract tests track the same
public fields.

## Deliberate boundaries

The analyzer does not execute game scripts to infer behavior. Unknown indirect targets and values are conservative.
Engine correctness is checked with differential fixtures and the official test runners, not a claim that static analysis
predicts every runtime failure. Dialogue warnings are an editing aid, not an additional rule of ChoiceScript syntax.
Preview refresh is explicit to avoid discarding game progress during typing.

The pinned upstream compiler's VM-loaded `mygamegenerator.js` expects `rootDir` to be global. The tooling supplies a
staging-only Node preload defining `global.rootDir = 'web/'`; no vendored source is patched. An integration test
exercises this compatibility bridge.
