# Tooling protocol and editor API

Standard LSP carries completion, hover, definitions, references, rename, symbols, folding, selection ranges, diagnostics, and semantic tokens. Branchlight adds a small protocol for projects and game operations.

The authoritative TypeScript contracts are in [packages/protocol/src/index.ts](../packages/protocol/src/index.ts). Kotlin DTOs mirror them, and contract tests check agreement. The current protocol version is **1**; this is a prerelease interface.

## Methods

| Method                         | Direction           | Purpose                                              |
| ------------------------------ | ------------------- | ---------------------------------------------------- |
| `choicescript/projects`        | Client request      | Return detected `Project` objects                    |
| `choicescript/projectsChanged` | Server notification | Replace the client's project list                    |
| `choicescript/job`             | Client request      | Start or stop a tooling operation                    |
| `choicescript/jobEvent`        | Server notification | Report output and job lifecycle changes              |
| `choicescript/wordCount`       | Client request      | Return the narrative word count for `{ "uri": "…" }` |

These method names are wire identifiers retained by Branchlight. They do not indicate upstream affiliation.

A `Project` contains `id`, `name`, `root`, `sceneDir`, `assetDir`, and optional `randomtest` defaults. Treat `id` as the server's identifier and pass it back unchanged. Filesystem paths and document URIs have distinct fields.

## Job requests

Every request carries `protocolVersion` and `operation`. Supported operations are `createProject`, `run`, `stop`, `quicktest`, `randomtest`, and `exportHtml`.

| Field                | Use                                                             |
| -------------------- | --------------------------------------------------------------- |
| `projectId`          | Select a discovered game for operations on an existing project  |
| `destination`        | New project directory or exported HTML path                     |
| `iterations`, `seed` | RandomTest options; omitted values use project defaults         |
| `showText`           | Include narrative text in RandomTest output                     |
| `jobId`              | Stop a particular job; omit to stop the selected project's jobs |
| `trusted`            | Trust state supplied by the editor, required for execution      |

Example request, with the placeholder replaced by an ID returned from discovery:

```json
{
  "protocolVersion": 1,
  "operation": "randomtest",
  "projectId": "<discovered-project-id>",
  "iterations": 1000,
  "seed": 0,
  "trusted": true
}
```

The `JobResult` returns `jobId` and `projectId`, plus `url` for preview or `output` for a saved log when applicable. For test and export jobs, the wire response acknowledges the start; wait for a `completed` event before treating the operation as finished. Creation completes directly with its result.

## Job events

Events carry `protocolVersion`, `jobId`, `projectId`, and `kind`. Correlate by job ID, including when multiple projects have work in flight.

| Kind         | Associated fields and meaning                                     |
| ------------ | ----------------------------------------------------------------- |
| `started`    | A job has started                                                 |
| `output`     | `message` contains runner output or status                        |
| `diagnostic` | `message`, `uri`, and zero-based `line` locate a reported failure |
| `coverage`   | `coverage` maps scene names to arrays of line hit counts          |
| `preview`    | `url` identifies the active preview                               |
| `completed`  | `exitCode` and optional `message`, usually the saved log path     |
| `stale`      | Source changes invalidate the job's snapshot as a current result  |

Coverage arrays use zero-based line positions. Available event fields are optional; do not assume every operation emits coverage or a source location. The optional `stale` flag can accompany other events. Completion exit code `0` means success and `130` means cancellation; other nonzero values indicate failure.

Progress is event-driven and indeterminate; the protocol has no percentage-complete field. A stale result remains a result of its original snapshot, not the latest buffer contents.

## VS Code integration API

The extension identifier is `chinay.branchlight`. After activation, its exported API provides `projects()` and `onJobEvent`. Tool commands accept an optional options object:

| Command ID                  | Operation                              |
| --------------------------- | -------------------------------------- |
| `branchlight.createProject` | Create a game from the pinned template |
| `branchlight.run`           | Start preview                          |
| `branchlight.stop`          | Stop a preview or test job             |
| `branchlight.quicktest`     | Run QuickTest                          |
| `branchlight.randomtest`    | Run RandomTest                         |
| `branchlight.exportHtml`    | Export HTML and assets                 |

Options are `projectId`, `destination`, `iterations`, `seed`, and `jobId`. Project creation also accepts `openCreatedProject: false`. Omitted interactive choices prompt normally. Supplying both RandomTest values avoids its iteration/seed prompts.

Commands enforce editor trust and do not accept overrides of the operation or protocol version. On a successful start they return `JobResult`; the test/export commands wait for completion before returning it. A returned handle is not itself evidence of success: inspect the correlated completion event's `exitCode`. Cancellation of a dialog, a missing project, or an error may yield no result.

`branchlight.wordCount` returns the count as well as displaying it. `branchlight.bold`, `branchlight.italic`, and `branchlight.about` are editor actions rather than game jobs.
