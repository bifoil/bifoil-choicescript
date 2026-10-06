# Language server and tooling protocol

The server speaks LSP over stdio and adds project/game operations. Current custom protocol version: **1**.
This is a prerelease interface. The authoritative declarations are
[`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts); option constraints live in
[`options.ts`](../packages/protocol/src/options.ts). Kotlin DTOs must remain wire-compatible.

Custom `choicescript/*` method names are retained identifiers, not a claim of upstream affiliation.

## Standard LSP

The server supports incremental document synchronization and these features:

| Feature                      | Notes                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Completion                   | Triggers include `*` and `{`; context-dependent suggestions                  |
| Hover                        | Command documentation and resolved symbol information                        |
| Definition / references      | Resolved code symbols; complete-project readiness matters                    |
| Prepare rename / rename      | Validated identifiers and collision checks; known semantic edge cases remain |
| Document / workspace symbols | Declarations and project symbol queries                                      |
| Folding                      | Indented blocks                                                              |
| Selection ranges             | Token, line, document                                                        |
| Diagnostics                  | Syntax/analysis, configuration, fresh job failures                           |
| Semantic tokens              | Full results; no range or delta implementation                               |
| Workspace folders            | Discovery and invalidation across roots                                      |

Initialize with `workspaceFolders` where available. The legacy `rootUri` remains a compatibility fallback.
The optional initialization setting is `initializationOptions.quoteWarnings`, default `true`.
Subsequent `workspace/didChangeConfiguration` reads
`settings.bifoil.choicescript.quoteWarnings`.

Document URIs are `file:` URIs. Filesystem path fields and URI fields are distinct; use a URI library instead of
concatenating `file://` with a path containing spaces or Unicode. Positions and ranges use UTF-16.

## Custom methods

| Method                         | Direction           | Parameters / result                                  |
| ------------------------------ | ------------------- | ---------------------------------------------------- |
| `choicescript/projects`        | Client request      | No parameters → `Project[]`                          |
| `choicescript/projectsChanged` | Server notification | Complete replacement `Project[]`                     |
| `choicescript/indexStatus`     | Client request      | No parameters → `IndexStatus[]`                      |
| `choicescript/wordCount`       | Client request      | `{ uri: string }` → active-document count            |
| `choicescript/job`             | Client request      | `JobRequest` → `JobResult`                           |
| `choicescript/jobEvent`        | Server notification | `JobEvent`                                           |
| `choicescript/assetChanged`    | Client notification | `{ uri: string }` invalidates affected job freshness |

Use normal LSP document/file/workspace notifications too. `assetChanged` is not a replacement for source
synchronization.

A `Project` has `id`, `name`, `root`, `sceneDir`, `assetDir`, and optional `randomtest` defaults.
The three directory fields are filesystem paths. The implementation derives `id` from the scene-directory URI, but
clients should treat it as opaque and return it unchanged.

Subscribe before requesting work: notifications can precede the corresponding request response.
`projectsChanged` replaces a list rather than appending one. Native transports must correctly handle its array payload;
the existing JetBrains binding has a [known issue](known-limitations.md#editor-integration).

## Index status

Each status record contains:

| Field       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `projectId` | Discovered project ID                                                           |
| `scenes`    | Enumerated scene count                                                          |
| `indexed`   | Cached scene-summary count                                                      |
| `words`     | Sum of available analyzed narrative word counts                                 |
| `failures`  | Recorded per-file indexing failures                                             |
| `complete`  | Current, nontruncated analysis with complete context and no dirty project state |
| `limited`   | The current snapshot reached its analysis work limit                            |

`indexed === scenes` is not equivalent to `complete`. Counts can be partial while indexing.
Startup scenes are always analyzed from full source and do not need a cached projection.
`failures` is not a universal process-health counter; a worker-level crash need not appear as a failed file.
This read-only request does not authorize game execution.

## Job requests

Required fields are `protocolVersion: 1` and `operation`.

| Field         | Type                 | Use                                                                     |
| ------------- | -------------------- | ----------------------------------------------------------------------- |
| `operation`   | String union         | `createProject`, `run`, `stop`, `quicktest`, `randomtest`, `exportHtml` |
| `projectId`   | Optional string      | Required to select an existing game for start operations                |
| `destination` | Optional path string | New project directory or output HTML file                               |
| `iterations`  | Optional integer     | RandomTest iterations; request overrides project default                |
| `seed`        | Optional integer     | RandomTest seed; request overrides project default                      |
| `showText`    | Optional boolean     | Include narrative output from RandomTest                                |
| `jobId`       | Optional string      | Fresh UUID for a started job, or existing ID to stop                    |
| `trusted`     | Optional boolean     | Editor trust decision; required truthy for operations other than stop   |

Iterations default to `1000` and seed to `0` after project defaults. Bounds are in
[configuration](configuration.md#randomtest-defaults-and-ranges).
A start UUID must be fresh; active/recent duplicate IDs are rejected.
Use `jobId` when cancelling before a start response has supplied an ID.

Example logical request parameters:

```json
{
  "protocolVersion": 1,
  "operation": "randomtest",
  "projectId": "<id returned by choicescript/projects>",
  "iterations": 20,
  "seed": 0,
  "jobId": "7f2a865b-06a2-4a7c-92bd-993c628e3a29",
  "trusted": true
}
```

Generate a new UUID for each actual run; do not reuse the example.

The server also advertises six `workspace/executeCommand` names,
`bifoil.choicescript.server.<operation>`. Supply the `JobRequest` as `arguments[0]`.
The request object's operation is authoritative in the current handler; clients should keep it consistent with the
command name. These commands are separate from editor command IDs.

## Responses and lifecycle

`JobResult` contains `jobId` and `projectId`, plus optional `url` or `output`.
`output` is a saved-log path where applicable, not the compiled HTML contents.

For test/export operations, the response follows preparation and process start; it does **not** mean completion.
For a preview, the response follows server startup and includes the preview URL.
Project creation completes directly, returns the sentinel job ID `"created"`, and does not follow the usual emitted
start/output/completion stream.

A typical test sequence is:

```text
client installs jobEvent listener
client sends job request with fresh UUID
server emits started (preparation may still be pending)
server prepares snapshot and launches child
server returns JobResult
server emits output / diagnostic / coverage as available
server emits completed
```

Fast completion or preparation failure can alter the relative order of response and notifications.
Correlate by UUID from the outset; never register the completion listener only after awaiting the response.

## Events

Every `JobEvent` has `protocolVersion`, `jobId`, `projectId`, and `kind`.
Other fields are optional.

| Kind         | Fields and meaning                                                              |
| ------------ | ------------------------------------------------------------------------------- |
| `started`    | Job registered; not a guarantee that the child is running                       |
| `output`     | `message` is output/status text, possibly a chunk                               |
| `diagnostic` | `message`, optional `uri`, zero-based `line`, severity `1` error or `2` warning |
| `coverage`   | `coverage` maps scene names to arrays of line hit counts                        |
| `preview`    | `url` is the local preview address                                              |
| `completed`  | `exitCode` and optional `message`, often the saved-log path                     |
| `stale`      | Source changed relative to the captured snapshot                                |

Coverage array indices are zero-based source lines. Missing entries/events do not establish zero coverage.
`stale` may also be a flag on other events. Preserve output history, but do not present stale results as current
diagnostics. The current implementation has documented invalidation gaps.

Completion `0` means success, `130` means cancellation, and other nonzero values mean failure.
Progress is indeterminate; there is no percentage field.

## Stop and errors

A stop request can specify `jobId`, `projectId`, or both. Omitting both stops all owned jobs.
Stopping by owned identity does not require source files still to exist. Do not send an unscoped stop when only one
project should be cancelled.

| Error                       | Meaning / client response                                                           |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `InvalidParams (-32602)`    | Wrong protocol version or malformed request; fix the caller                         |
| `InvalidRequest (-32600)`   | Execution without required trust; use the editor trust flow                         |
| `RequestCancelled (-32800)` | Cancellation prevented a request from completing; settle pending UI                 |
| `ContentModified (-32801)`  | No suitable current language snapshot within the request window; retry when current |
| Other rejected request      | Read the message for invalid selection, filesystem, preparation, or runtime failure |

Not every preparation failure is mapped to a structured domain error. Preparation-cancellation mapping and adapter
presentation have known gaps. A completed event can accompany a rejected start, so client settlement must be idempotent.
A lost server session must also settle outstanding progress/listeners.

Neither a timeout nor an empty placeholder counts as a useful sub-second language response.
The trust boolean is an adapter contract, not authorization for a network-exposed server.

## VS Code exported API

Extension ID: `bifoil.choicescript`. After activation, the exported object provides `projects()` and `onJobEvent`.
Use the normal extension API to obtain it:

```typescript
const extension = vscode.extensions.getExtension("bifoil.choicescript");
if (!extension) throw new Error("Bifoil ChoiceScript is not installed");
const api = await extension.activate();
const subscription = api.onJobEvent((event) => {
  // Correlate event.jobId and inspect completed.exitCode.
});
const projects = api.projects();
// Dispose subscription when the integration no longer needs it.
```

Editor tool commands accept optional `projectId`, `destination`, `iterations`, `seed`, and `jobId` options.
Creation also accepts `openCreatedProject: false`. Omitted selections prompt interactively; supplying both RandomTest
values avoids its option dialogs.

The editor enforces workspace trust; callers cannot override operation or protocol version.
Test/export commands wait for completion before returning their handle, but that handle does not prove success.
Listen before invoking and inspect completion. Those commands currently allocate their own start UUID rather than
preserving a caller-supplied one. Cancellation or errors can yield no usable result.

`wordCount` also returns its displayed number. Markup and About are editor actions, not job operations.
The extension does not export a general-purpose raw language-client handle.
