# 0.1.0 candidate notes

**Unreleased private prerelease.** This document describes the current development candidate; it is not an announcement
of a published release or a certificate that every target has passed acceptance.

## Implemented

- A shared TypeScript parser, control-flow/type analysis, language server, and tooling service.
- Separate state for expression strings and narrative dialogue, including conditional branch joins, scenes, and calls.
- Semantic categories for dialogue, narrative, expressions, markup, and inferred variable types.
- Completion, hover, definitions, references, rename, symbols, folding, selections, snippets, and word counts.
- Project-aware text-file association, conventional engine layouts, multiple games, and optional configuration.
- Creation from the pinned official template, local preview, official QuickTest/seeded RandomTest, coverage data,
  cancellation, saved test output, and HTML export with companion assets.
- VS Code and JetBrains adapters, bundled Node.js 24, engine/runtime provenance, and packaging scripts.

The adapters expose the same shared language model, but presentation and transport defects mean their current behavior
is not fully equivalent.

## Declared targets

VS Code desktop 1.109+; IntelliJ IDEA, WebStorm, and PyCharm 2026.1.4 at the documented
[build baselines](jetbrains-compatibility.md). Packaging covers Windows, macOS, and glibc Linux on x64 and ARM64. A
host-only local JetBrains bundle covers only its prepared runtime, not that whole matrix.

The bundled unmodified engine is pinned to `60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a`. Original plugin code is MIT
licensed; upstream material retains its separate license and notices.

## Known limitations

The [maintained limitations page](known-limitations.md) is the detailed reference. In particular:

- The combined 256 MiB memory limit, sub-second useful responses, and support for games with tens of millions of words
  remain unmet across required workloads.
- Some symbol/rename, array/indirect-reference, and index-invalidation cases remain incorrect.
- JetBrains coverage notification delivery is unreliable; native rendering also needs scale work.
- Cancellation, process cleanup, stale-result handling, and export font assets have remaining gaps.
- Full native/manual acceptance for each current package and declared target must be established independently.

Browser-only VS Code, Android Studio, older Community editions, debugging, marketplace publication, and future Bifoil
language/toolchain products are outside this candidate's scope.

## Installing and reporting issues

Follow [installation](support.md), then the [first-game walkthrough](getting-started.md). Use an original minimal
reproduction and sanitized logs when [reporting a problem](troubleshooting.md#reporting-a-problem). Record the exact
candidate, source revision where available, editor version, and host architecture.

Before attaching these notes to an actual release, maintainers must identify the candidate revision and update
validation status using [the release procedure](releasing.md).
