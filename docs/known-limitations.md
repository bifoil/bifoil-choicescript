# Known limitations

This is a working prerelease. The features described elsewhere are implemented, but the following gaps prevent treating
them as fully accepted across editors and workloads. This page describes user-visible consequences, not private audit
logs or a promise that all defects are listed.

## Performance and scale

The target is at most **256 MiB of combined plugin-owned runtime resident memory**, useful responses **below 1,000 ms**
(ideally below 500 ms), and games with **tens of millions of words**.
Those requirements are not yet met across the required workloads.

Large or command-heavy games can exhaust the analysis worker or official tool process heaps. Interactions requiring
current project analysis may time out or remain unavailable. A prose-heavy many-scene result does not establish support
for giant individual scenes, recursive/control-flow-heavy games, or testing/export at the same scale.

There is no supported setting that makes these limits disappear. See [performance](performance.md) for the current
resource model and valid acceptance measurements.

## Language analysis and rename

- Special identifiers and function-name parsing have edge cases, including `auto` and identifiers overlapping built-in
  function names such as `round`.
- Some stat-chart display text and conditional/shadowed bindings can be included incorrectly in symbol operations.
- Arrays, indirect assignment, and changing shadowed bindings still have analysis gaps.
- Dynamic destinations, generated text, incomplete projects, and analysis budgets can reduce precision even without a
  parser error.

Review rename edits before applying them, inspect indirect references manually, and run official tests afterward.
Scene-file rename is not implemented through symbol rename. Neutral highlighting is not evidence of an error by itself.

## Index freshness

Configured scene directories outside the opened workspace may not receive the expected file-watch events.
Directory-only deletion/move notifications can leave stale membership or results. Recent-job history is bounded;
older retained diagnostics can have invalidation edge cases after history eviction.

If a project is out of date, save files, reopen/reload the workspace, and rerun the operation. A discovered project or a
count of indexed files does not prove that current whole-project analysis is complete.

## Editor integration

JetBrains project-change notification binding currently prevents reliable coverage association in the normal native
LSP path. Tool actions that query projects directly are separate from that failure. Lack of coverage decorations is not
proof of a run with no executed lines.

Coverage rendering also needs improvement for high line counts; updating many markers on the UI thread can stall the
editor. Unit tests of a decoration store do not establish native rendering performance.

VS Code starting a preview closes existing preview panels, including those for another game. A source change very
early during preview startup may miss its visible stale marker. Treat previews as explicit snapshots and restart them
after edits.

## Game tools

- Cancellation can be delayed for queued/preparing jobs, and preparation cancellation can appear as an adapter error.
- Cleanup is not guaranteed for arbitrary descendant processes; queued-job resource handling has remaining gaps.
- The child used to generate runtime scene data has a time/output limit, but there is no overall deadline for all
  staging, queueing, QuickTest, RandomTest, or compilation.
- Logs do not have a total-size quota.
- Export can omit engine-provided font assets. Test the exported files in a browser, including typography.
- Creation/export preserve existing files but can leave partial new output after a failure.
- Stopping a preview does not terminate JavaScript already loaded into an open browser page.

For regular authoring, use a fresh export directory, retain a saved source revision for reproducible tests, close old
preview pages, and inspect tool output rather than relying solely on a success notification.

## Compatibility and release validation

The platform/package matrix is a target, not evidence that every current artifact has passed native and visual checks.
Source tests, native unit tests, Plugin Verifier, installed-package smoke tests, and manual light/dark UI checks
establish
different things.

The existing large-game benchmark includes repeated prose-edit cases that can become no-ops, and its memory sampling
does not cover all runtime processes on all platforms. It cannot by itself establish scale acceptance.
See [testing](testing.md).

The private release workflow does not enforce that a requested tag is unused. An existing tag may point to a different
revision from newly built assets; maintainers must check the tag/source relationship before publication.
See [releasing](releasing.md#private-prerelease-workflow).

Browser-only VS Code, Android Studio, older Community editions, debugging, and marketplace publication are outside the
first release. Planned Bifoil ecosystem projects are not features of this plugin.
