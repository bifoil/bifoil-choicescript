# Performance and scale

The acceptance targets are:

| Dimension           | Required behavior                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Runtime memory      | At most **256 MiB combined resident memory** for plugin-owned language-server and game-tool processes   |
| Interaction latency | Useful, current response **below 1,000 ms** after the interaction; ideal **below 500 ms**               |
| Scale               | Games with **tens of millions of narrative words**, including representative control-flow complexity    |
| Correctness         | Current versions, nonempty useful results, accurate ranges/classifications, and responsive cancellation |

**These targets are not yet met across the required workloads.** Large/command-heavy analysis and official tools can
exhaust their heaps, and native editor behavior has remaining bottlenecks. This page defines what must be measured;
it does not claim that a heap flag enforces the total-memory requirement.

## Count the right memory

The language server process includes its worker threads in its RSS/working set. Do not add a second process-sized value
for the same worker memory. Add simultaneous owned generator, test, and compiler child-process resident memory.
Preview-server allocations inside the language server are already part of that process.

The editor's whole extension host, IDE JVM, JCEF/browser host, Gradle daemon, and test harness are not interchangeable
with the plugin-owned server/worker/tool budget. Report host responsiveness and other significant costs separately,
rather than hiding them or labeling the entire IDE as language-server memory.

Shared policy in [`runtime.ts`](../packages/protocol/src/runtime.ts) currently uses:

| Component              | V8 heap policy                                      |
| ---------------------- | --------------------------------------------------- |
| Server                 | 96 MiB old generation, 2 MiB semispace              |
| Analysis worker thread | 96 MiB old generation, 4 MiB young generation limit |
| Game-tool child        | 64 MiB old generation, 2 MiB semispace              |

Native allocations, stacks, buffers, code, young generations, and mappings also consume memory.
Heap limits can cause a tool to fail without ever demonstrating successful work within 256 MiB.

## Measure the user's interaction

Start the timer at the typing/hover/completion/navigation event and stop when the corresponding current result is
available to the user. A server-only LSP round trip omits adapter processing, UI scheduling, token application, and
paint.

Record cold open, warm edits, structural edits, hover, completion, definitions, references, rename, and highlighting.
Check the result and document version. An empty completion list where symbols should exist, stale semantic tokens,
`ContentModified`, cancellation, or an error returned in 100 ms is not a successful 100 ms interaction.

Whole-project indexing and a long RandomTest run may take longer than one second. Their duration is a separate metric;
foreground interactions must remain responsive while that background work runs.

## Describe the workload

Words and lines are not interchangeable. Record:

- Actual narrative words, total source bytes, and physical lines.
- Scene count and distribution of individual scene sizes, including the largest open file.
- Command density, branch nesting, jumps, calls, recursion, arrays, and interpolation.
- Open buffers, active projects, dirty versions, and whether indexing is complete.
- Concurrent preview/test/export operations.
- Host OS/architecture, packaged runtime, editor version, source revision, and warm/cold cache state.

A million short prose lines compress differently from a command-heavy game of the same word count.
Many modest scenes and one giant scene exercise different paths. Results from one cannot be substituted for the other.

## Existing automated checks

The [server performance suite](../packages/server/test/performance.test.ts) uses original synthetic games and production
Node flags to check current semantic results and interaction timings. It is useful regression coverage, not all-editor
end-to-end acceptance.

The opt-in benchmark is:

```sh
pnpm build
node --import tsx scripts/benchmark-large-game.mjs 1000 30000
```

This generates 1,000 chapters with 30,000 narrative words each, plus startup: **30 million narrative words**.
The first two arguments specify the number of chapters and the words per chapter. An optional report-path argument after those values
selects the report path, for example:

```sh
node --import tsx scripts/benchmark-large-game.mjs 1000 30000 .bifoil-choicescript/development/scale/report.json
```

The source corpus is temporary and removed afterward; the JSON report is retained in ignored development output.
The run is opt-in because source generation, indexing, and failures can consume substantial time and resources.

Current benchmark limitations:

- Repeated prose-edit iterations can become no-ops after the initial replacement.
- Windows monitoring samples server working set, including threads, but no game-tool children are exercised.
- Other platforms do not currently get resident-memory sampling from this harness.
- It measures language-service responses, not native editor paint/application latency.
- Its mostly prose workload does not establish command-heavy or giant-scene acceptance.

Do not present this benchmark alone as a passed 256 MiB or native-editor scale gate.

## Acceptance procedure

Use a packaged candidate, original disposable games, and an available native editor session.
Verify the loaded adapter/server artifacts correspond to the source revision under test.
Run a prose-heavy many-scene game and independently stress command-heavy and large-open-scene cases.

Use edits with a changing value every time. Assert updated source versions and expected semantic changes.
Exercise official QuickTest, seeded RandomTest, export, and preview alongside language interactions.
Sample the whole owned process tree frequently enough to catch concurrent peaks; retain sample scope and timestamps.

For each editor, include cold and warm runs, UI-applied tokens/diagnostics, project-change notifications, coverage,
cancelled preparation, shutdown, and process cleanup. Report failures and unverified dimensions explicitly.
A heap crash, a native callback error, or a locked/unavailable desktop is not a passed performance check.

## Optimization constraints

Do not achieve a lower number by dropping needed symbols, skipping closed scenes, returning stale results, or disabling
features without documenting a deliberate scope change. Projections and incremental updates must preserve the full
analysis contract on their supported inputs.

The current design uses compact scene summaries, bounded compressed caches, limited worker concurrency, and a shared
tool-child slot. These help specific allocations; they are not an end-to-end resource guarantee.
See [architecture](architecture.md) and [known limitations](known-limitations.md).
