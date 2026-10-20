# Known limitations

Bifoil ChoiceScript is in private prerelease development. This page describes limits of the current native backend and
its acceptance evidence. It is not a list of every possible defect.

## Resource and latency acceptance

The requirements are complete analysis, useful current responses below **1,000 ms** (ideally **500 ms**), and at most
**256 MiB combined resident memory** across plugin-owned server and tooling processes. Scale includes tens of millions
of narrative words. Selected large-game runs have met these limits; every workload and native editor path has not yet
been accepted.

The native server does not automatically replace failed whole-project flow with foreground-only or syntax-only results.
The earlier TypeScript implementation remains in source for comparison, and its reduced-analysis fallback is not the
installed runtime path. A full-analysis failure or unavailable current snapshot is still a failure to provide the
required interaction.

A giant single physical paragraph, many giant open buffers, dense control flow, rapid sustained edits and simultaneous
projects need independent stress checks. Text retention and query paging do not bound every line-offset allocation or
large feature response. Official tools can also hit legitimate upstream limits. The pinned QuickTest input-size guard
is preserved.

Memory targets are soft runtime policies, not an operating-system cap on combined resident memory. A selected
20-million-word RandomTest workload measured 215.8 MiB combined memory. This leaves headroom in that run but does not
prove an upper bound for every workload. See
[performance](performance.md) for measurement scope and acceptance rules.

## Language analysis and rename

Dynamic destinations, unknown generated text and unresolved indirect names can reduce precision. Mixed values and
uncertain dialogue use neutral styling. This is different from omitting scenes or skipping control-flow analysis.
Malformed or incomplete games may produce valid syntax diagnostics even when the plugin is working correctly.

Rename operates on resolved symbols and conservatively refuses cases where it cannot establish a safe edit. Review its
preview, especially around generated array names, indirection and shadowing. Scene-file rename is not implemented by
symbol rename. Editor diagnostics do not replace official tests or manual play.

## Native editor delivery

The project-change notification uses a versioned object, with regression coverage through actual LSP4J framing and
reflective decoding. Coverage decorators retain full counts and create markers only for visible rows. These correct the
previous notification-binding and unbounded-decoration paths, but helper/transport tests alone do not establish every
built-in IDE manager callback or paint-time deadline.

Installed VS Code smoke tests, JetBrains native transport tests, Plugin Verifier and manual light/dark checks establish
different things. Report the exact artifact, editor, workload and assertions exercised. Other IDE products and platforms
need their own runs; a compatible API report does not prove responsive rendering.

Configured scene roots outside the workspace depend on adapter file-watch delivery. If external changes appear absent,
save/reopen the affected files or reload the workspace and verify project readiness. A detected game or scene count does
not prove that the current full analysis has completed.

## Game tools and snapshots

Tooling runs captured source snapshots. Later edits mark a result stale and require an explicit rerun or preview restart.
Stopping the preview server cannot terminate JavaScript already loaded into a browser page. Closing that page is a
separate action.

The preparation generator has a time/output limit. There is no overall deadline for every staging, queueing, official
test or compilation phase, and logs have no total-size quota. Large sources can therefore take substantial time and
storage even while language interactions remain responsive.

Creation and export preserve existing destination files but may leave partial newly created output after a failure.
Use a fresh destination and inspect the result. Exported font/companion-asset behavior needs browser acceptance alongside
the compiler-output regressions. A successful test run or export does not prove story completeness.

Owned process cleanup uses Windows Job Objects or Unix process groups. Shutdown, cancellation, project removal and
preview restart have separate regressions; unexpected operating-system failures still need actionable reporting.

## Compatibility and release validation

The six-target package matrix is a delivery target. Cross-compilation is not execution on every target. Current native
and resource measurements must not be generalized to untested operating systems, architectures, IDE products or games.
The reference TypeScript benchmark is not an acceptance harness for the installed native backend.

The private release workflow does not enforce that a requested tag is unused. An existing tag may point to a different
revision from newly built assets; maintainers must check that relationship before publication. Ordinary pushes run
checks without building installers; packaging requires the explicit workflow input. See [testing](testing.md) and
[releasing](releasing.md).

Browser-only VS Code, Android Studio, older Community editions, debugging and marketplace publication are outside the
first release. Planned Bifoil ecosystem projects are not features of this plugin.
