# Preview, test, and export

Both adapters request game operations from the shared language server. Operations use the bundled engine pinned to
`60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a`. They do not execute an arbitrary engine checkout selected by your project.

Use the Command Palette in VS Code or **Tools → Bifoil ChoiceScript** in JetBrains. Execution requires a trusted
workspace. Syntax and language assistance remain usable without trust.

## What a run contains

Each run creates a disposable staging directory containing the bundled engine, your scene sources, and eligible game
assets. Open scene buffers override their on-disk versions, including unsaved scene text. Other assets come from disk.
Edits after capture belong to a later run.

A file changed while being copied can cause preparation to fail; retry after the write finishes. Staging is not a
transactional snapshot of the whole filesystem. Save non-scene assets and avoid concurrent external writes when you need
a precisely reproducible run.

Scene paths must be flat within the configured directory. Assets can use subdirectories. The copy rules skip common
generated/private paths; a dedicated asset root gives a clearer distribution boundary. See
[data and execution](data-and-execution.md) for exclusions.

Engine preparation and test/compiler child execution share a process slot. Work may queue while another tool runs.
Per-project ordering and global child-process limits are implementation details, not a promise of immediate cancellation
or bounded total memory. Analysis continues separately.

## Preview

Invoke **Run Game** to stage the current game and open its preview. The local HTTP server binds to `127.0.0.1` on an
available port and uses an unpredictable URL path. The editor displays that URL through a VS Code webview or JetBrains
JCEF, with a browser fallback.

To apply edits, invoke **Run Game** again. Preview does not hot-reload source and does not automatically preserve your
playthrough when restarted. Source changes mark the run stale, although a change during startup can miss the visible
stale indicator.

**Stop Game or Tests** stops the owned preview server. Closing the preview also requests cleanup. Already loaded
JavaScript in an open page can keep running after the server stops; close that page to end the visible session. An old
tab is not proof that the server remains alive.

The VS Code UI currently closes existing preview panels when starting another game's preview. Treat it as a single
visible-preview workflow rather than relying on multiple independent preview panels.

## QuickTest

**Run QuickTest** invokes the official QuickTest script against the staged game. It is useful for structural and path
errors, but its abstract execution is different from a normal player's run. Pair it with RandomTest and manual play.

Output appears in the editor's Bifoil ChoiceScript output/tool window. Recognized source failures become clickable
diagnostics. An unsuccessful process exit is not always a scene bug: preparation, runtime launch, filesystem, and
resource failures must be read from the actual output.

## RandomTest and reproducibility

**Run RandomTest** asks for iteration count and seed, using project defaults if present. The runner performs seeded
playthroughs with coverage enabled; the UI does not expose every upstream runner flag. Typical development values are 20
iterations for a quick check or 1,000 for a broader local run.

Use the same source snapshot, engine pin, seed, and iteration count when reproducing a failure. The supported range and
seed-overflow rule are in [configuration](configuration.md#randomtest-defaults-and-ranges). A seed alone does not
identify a reproducible test if the game's source or engine changed.

Passing sampled runs does not prove every branch works. Increasing iterations improves sampling, not correctness
guarantees. There is no general wall-clock timeout for the whole test run; cancel when needed.

## Coverage

Coverage events map scene names to arrays of line execution counts. The adapters use those counts for line decorations
and execution-count hover text. Positive counts mean observed execution in that run. An absent or zero count is not a
static proof of unreachable code.

Coverage applies to the captured snapshot. Scene or asset changes make previous results stale; rerun before using
coverage to assess the current source. Runs without coverage should not be interpreted as zero coverage.

VS Code implements these decorations. **JetBrains coverage is currently not reliable** because project-change
notification handling can prevent coverage from being associated with its project. This is a known implementation gap,
not a setting to enable. See [known limitations](known-limitations.md).

## Progress, cancellation, and stale results

The editor displays progress for tests and export. Use its cancel control or **Stop Game or Tests**. A job ID ties
output, diagnostics, coverage, and completion to a single operation.

A completed cancellation uses exit code `130`. Success uses `0`; other codes represent failure. Cancelling before
preparation finishes can instead reject the start request. Edge cases in the adapters and job queue can delay
cancellation or show a cancellation as an error. Do not treat a progress spinner disappearing as proof that every owned
process exited.

Source edits mark results stale because a finished run describes an older snapshot. The implementation tries to clear
stale diagnostics/coverage, but directory-watch and retained-history edge cases remain. If old failures persist, save,
reload the workspace, and rerun. Keep the failure's source revision with any bug report.

## Saved output

Test and compilation output is saved under the game's root:

```text
.bifoil-choicescript/logs/<job-id>.log
```

The directory is local output, not game source. Log saving can itself fail; the editor reports that separately. Logs may
contain story text, variable values, and filesystem paths. Review them before sharing.

Output shown in the UI can be chunked, and saved logs have no total-size quota. Very chatty tests can consume disk
space. Preview is a local server session, not a test process with the same persistent log behavior.

## Export HTML

Invoke **Export HTML**, then select a new destination file. In VS Code the initial suggestion is `export/game.html`
under the game root.

The runner compiles a staged snapshot, copies the HTML, and copies required eligible game companion assets. Keep
companion files in their relative locations beside the exported game. Exporting is not necessarily producing one fully
self-contained HTML file.

Destination writes preserve existing files instead of overwriting collisions. A failure partway through can leave a
partial new export; review that directory before retrying, or choose a fresh one. There is a known gap copying certain
engine-provided font assets. Check typography and assets in the output itself, not just the compiler's exit status.

No hosting, marketplace publication, or deployment follows automatically. The ChoiceScript engine and any fonts, images,
music, or other assets retain their respective licenses.

## New Project

**New Project** copies the pinned official game template into a new or empty destination and writes default
`choicescript.json`, `CHOICESCRIPT-LICENSE.txt`, and `UPSTREAM-TEMPLATE.md`. Existing nonempty directories are rejected.
If copying fails after some files have been created, inspect the partial directory rather than retrying as though it
were still empty.

Use the [walkthrough](getting-started.md) to replace the sample story with a small original game.
