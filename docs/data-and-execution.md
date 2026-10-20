# Data and execution boundaries

Bifoil ChoiceScript analyzes source files and runs bundled game tooling on your machine. This page explains what it
reads, copies, executes, and writes. Use this information to choose appropriate project boundaries.

## Workspace trust

Language assistance remains enabled for untrusted projects. Creating a project, previewing, running tests, and exporting
require editor workspace trust. Stopping an already owned operation remains available without trust.

The shared protocol's `trusted` field conveys an adapter decision. It is not a cryptographic credential or a security
boundary for a public service. The language server uses stdio and is intended to be launched by its editor adapter.

ChoiceScript can contain executable constructs and reference browser assets. Trust should come from your knowledge of
the game source. The plugin is not a hostile-code sandbox, and successful analysis does not establish that game code is
safe to execute.

## Source and asset reads

Discovery reads workspace directories and optional `choicescript.json` files. Analysis reads scene text and open
buffers. Tooling writes a staged engine/game tree to an operating-system temporary directory.

Asset staging skips hidden descendants, common generated directories, the configured scenes subtree, common credential
filenames, and private-key/certificate-container extensions. Examples include `.git`, `node_modules`, `vendor`, `dist`,
`build`, `export`, `.idea`, `.gradle`, `.bifoil-choicescript`, `.env`, `.npmrc`, `.ssh`, `.aws`, and `.pem` / `.key` /
`.p12` / `.pfx` files. The source of the exact filter is [the runner](../packages/tooling/src/runner.ts).

Descendant symlinks are skipped during ordinary copies. Explicit root paths can themselves resolve through symlinks, so
“symlinks are skipped” is not a general containment claim for any configured root.

These exclusions do not classify every private file. A normal `planning.txt` or `budget.csv` under the asset root may be
copied. Prefer a dedicated game asset directory over pointing `assets` at a broad personal or multi-project folder.

## Local preview

Preview serves the staged web tree on loopback with an unpredictable path component. Path validation keeps requests
within the staged web root. The server disables caching to prevent responses from an earlier run appearing in a new one.
The URL is a local capability, not a production authentication mechanism.

The preview executes the game's client-side content. External URLs referenced by game assets can still cause the browser
to contact external services; “local preview” does not imply that arbitrary story content is network-isolated. Stopping
the server prevents further serving but cannot retract JavaScript already loaded into a browser page.

## Files written to your project

- New Project writes the template, its upstream attribution, a preserved engine license, and default configuration.
- Test/compiler output is saved under `.bifoil-choicescript/logs/`.
- Export writes the selected HTML and eligible companion assets to the selected destination.
- The editors retain their ordinary settings, caches, and file-history behavior.

Preview/tests operate on staged copies rather than rewriting source scenes. Open-buffer snapshots can differ from the
saved files; save a revision if you need to reproduce a result later.

Exports and project creation use collision-preserving writes, but are not atomic directory transactions. An interrupted
operation can leave newly created partial output. Inspect partial directories before removing anything.

## Logs, reports, and cleanup

Logs can include story text, runtime values, and paths. Share a minimal sanitized excerpt instead of uploading an
unreviewed game or full log. The plugin does not impose a total log-storage quota.

Owned direct processes and temporary directories are cleaned up when a job stops or the server shuts down, with retries
for some failures. Known cancellation and cleanup gaps remain, including arbitrary descendants and queued jobs; see
[known limitations](known-limitations.md#game-tools). Preserve evidence of a failure before removing task-owned
leftovers.

Development reports belong in ignored local output, not public docs. Test fixtures and issue examples should be original
or material you are authorized to share. See [contributing](../CONTRIBUTING.md) for reporting and review expectations.
