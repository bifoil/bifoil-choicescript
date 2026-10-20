# Performance and scale

The requirements are complete analysis, useful current responses below **1,000 ms** (ideally below **500 ms**), and at
most **256 MiB of combined resident memory** for every plugin-owned runtime process. Scale includes games with tens of
millions of narrative words. A heap limit, an empty answer or reduced analysis does not establish compliance.

The installed language service is native Go. Both adapters use it by default, with bundled Node reserved for game tools.
The earlier TypeScript server and its benchmarks remain available for regression comparisons; their fallback modes and
memory policies do not describe the installed native backend.

## What counts

Add the language server, tooling broker, official generator/test/compiler workers and any other owned runtime processes
at the same instant. Worker threads are already included in their host process. Report the **maximum simultaneous
sum**, not a sum of unrelated per-process high-water marks. The resource evidence sampler uses a 10 ms interval and
records server/tool contributions at the combined peak; sampling can miss shorter spikes.

The editor's whole extension host, IDE JVM, JCEF/browser, Gradle and test-client processes are separate measurements.
They still affect host responsiveness and should be reported when significant. Do not label the entire IDE as the plugin
runtime, or hide an oversized test client in a claim about low memory.

The native Go runtime uses a 96 MiB soft memory target and at most four runtime processors. This is a collection target,
not a resident-memory cap. The Node broker and official workers use independent heap policies in
[`runtime.ts`](../packages/protocol/src/runtime.ts). Source-adapted official workers use a 48 MiB old-generation limit;
legacy unadapted workers retain 64 MiB. Native buffers, stacks, code and mapped pages also consume resident memory.

## Preserve work while reducing allocations

The native implementation uses immutable file-backed sources, exact prose transfer summaries, persistent environments,
paged query indexes and lossless repeating semantic-token blocks. It does not skip closed scenes or discard types,
references or dialogue to obtain a lower memory number. A bounded cache reuses exact type/scope reads from immutable
environments; it checks every operand, clears before collected handles are reused, and is bypassed when discovering call
dependencies. Unsupported incremental changes trigger full analysis.

Official tools read bounded source pages and line indexes. Coverage transport streams complete counts. Export spools the
unchanged compiler's intermediate scene JSON instead of retaining a whole game in its worker heap. Both adapters limit
coverage decorations to visible rows while keeping all counts available.

These mechanisms have passed focused large-game checks, including a 20-million-word individual scene during official
RandomTest. A Windows x64 run measured 216.9 MiB combined resident memory, with current edits during execution in 563 ms;
this is evidence for that workload, not every-workload acceptance. Giant single physical lines, many large open buffers,
sustained edits and native UI delivery require their own measurements.

## Time the interaction that matters

Start at a typing, hover, completion or navigation event. Stop when its useful current result is available to the user.
Check the value, source version and ranges. Stale answers, placeholders, errors and `ContentModified` are failures for a
latency gate even if returned quickly.

Measure cold open, warm and structural edits, hover, completion, definitions, references, rename, symbols and semantic
highlighting. Include concurrent preview, official tests and export. A server-only LSP round trip omits adapter
processing, token application and paint; report it as server/transport evidence, not native visual acceptance.

Whole-project inventory and a long RandomTest or compilation can take longer than a second. Their total duration is a
separate metric. Foreground interactions must remain responsive throughout them.

## Describe each workload

Record actual narrative words, source bytes, physical lines, scene sizes, command density, branching, jumps, calls,
recursion, arrays and interpolation. Include open buffers, dirty versions, active projects, concurrent jobs, host
OS/architecture, editor/runtime versions, artifact hashes and warm/cold cache state.

Many small scenes, a giant scene with paragraphs, one giant physical paragraph and a command-heavy project stress
different paths. Do not substitute one for another. An incomplete or malformed story is still a valid resilience input;
its parser diagnostics are distinct from plugin crashes, invalid ranges or incomplete analysis.

## Reproduce relevant checks

```sh
go test ./packages/core/src ./native/server
go test -race ./packages/core/src ./native/server
go vet ./packages/core/src ./native/server
pnpm check
```

Use the SDK pinned in [`toolchain.json`](../native/toolchain.json). Build and extract an actual package before installed
acceptance; [testing](testing.md) describes both editor workflows. Do not run compilers, Gradle or other heavy test
campaigns concurrently with a benchmark unless they are the workload being measured.

The existing opt-in reference benchmark is:

```sh
node --import tsx scripts/benchmark-large-game.mjs 1000 30000
```

It generates 30 million narrative words across 1,000 chapters. It launches the reference TypeScript server, includes
iterations that can become no-op edits, and lacks complete cross-platform child-process measurement. It must not be
presented as acceptance of the installed native service.

For a valid scale campaign, use original disposable sources and changing edits on every iteration. Verify full scene
counts, complete semantic spans, actual type changes, diagnostics and navigation. Preserve immutable source hashes and
verify official compiled output or full coverage. Monitor simultaneous resident memory and host availability, test
cancellation/shutdown, and retain failures as well as passes.

Native editor execution, Plugin Verifier and manual light/dark/paint checks establish different things. Record exactly
which editor paths and artifacts were exercised. Passing selected Windows x64 workloads does not prove every platform,
IDE product or possible game. Remaining acceptance gaps belong in [known limitations](known-limitations.md).
