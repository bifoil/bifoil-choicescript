# Contributing to Bifoil ChoiceScript

Bifoil ChoiceScript is an unofficial personal project under the planned Bifoil Foundation umbrella, maintained by Chinay
and unaffiliated with Choice of Games or upstream ChoiceScript. It is currently a private prerelease; repository access
does not imply authorization to publish packages, change visibility, or release a candidate.

Read the applicable [AGENTS.md](AGENTS.md) when using an agent in this repository.

## Build from source

You need Git, Node.js 24, the pnpm version declared in [package.json](package.json), initialized submodules, and the
installed Go SDK pinned in [native/toolchain.json](native/toolchain.json).
JetBrains work additionally needs JDK 21 and the checked-in Gradle wrapper. Python is not a build requirement; use
system-installed `uv` if a development task needs it.

```sh
git -c core.autocrlf=false clone --recurse-submodules https://github.com/bifoil/bifoil-choicescript.git
cd bifoil-choicescript
git config core.autocrlf false
pnpm install --frozen-lockfile
pnpm check
```

For an existing checkout, initialize the engine before installing/building:

```sh
git -c core.autocrlf=false submodule update --init --recursive
```

Preserve upstream bytes and line endings. The engine is unmodified and pinned; a hash mismatch is not a reason to
regenerate hashes around an accidental local edit. Explicit install-script permissions live in
[pnpm-workspace.yaml](pnpm-workspace.yaml). Do not enable every dependency script to suppress an installation warning.

`pnpm check` builds shared/editor JavaScript, checks types, and runs package tests. It does not create every installer,
run all native editors, or establish release acceptance. See [development](docs/development.md) for focused commands and
[testing](docs/testing.md) for their scope.

## Choose the right layer

| Change                                     | Start in                                              |
| ------------------------------------------ | ----------------------------------------------------- |
| Parsing, quotation, types, symbols         | `packages/core`                                       |
| Snapshot freshness, workers, LSP           | `packages/server`                                     |
| Shared job options/events                  | `packages/protocol`, then both adapters               |
| Discovery, preview, official tests, export | `packages/tooling`                                    |
| VS Code presentation                       | `editors/vscode`                                      |
| JetBrains presentation                     | `editors/intellij`                                    |
| Commands/help/fallback metadata            | `packages/core/src/commands.json` and `pnpm generate` |

Read [architecture](docs/architecture.md), [language behavior](docs/specification.md), and [testing](docs/testing.md)
before changing analysis. Consult [protocol](docs/protocol.md) for the contracts between the server, tooling, and
adapters.

## Make a reviewable change

1. Inspect the working tree and preserve unrelated work.
2. Use a focused branch, normally `codex/<description>` for agent-created branches.
3. Reproduce a bug with a small original example.
4. Change the shared layer rather than implementing different semantics in each editor.
5. Add meaningful regressions for semantic, security, or lifecycle behavior.
6. Run the checks appropriate to the affected layer and inspect the diff.
7. Update the user-facing docs and known limitations when behavior changes.

Use `git mv` for tracked moves. Follow the maintainer's requested procedure for creating and signing commits; do not
rewrite history or force-push without authorization.

A change to runtime behavior needs more than a compilation check. Tests should detect a real regression, including
source ranges and failure paths where relevant, rather than mirror private implementation details. Documentation-only
edits ordinarily need formatting, link/example checks, and diff review rather than every SDK build.

## Style

TypeScript/JavaScript, JSON, XML, and SVG use the checked-in Prettier configuration: intentional `printWidth: 120`,
defaults otherwise, and `@prettier/plugin-xml`. Do not remove the configured width or invent an unrelated style.

```sh
pnpm format
pnpm exec prettier --write README.md CONTRIBUTING.md "docs/*.md"
git diff --check
```

`pnpm format` does not include Markdown. Format only the files relevant to the change if the tree contains unrelated
work. Write ordinary multiline Kotlin; avoid semicolon-delimited compressed statements. Use the IDE formatter and
focused inspections for Kotlin.

## Reports and documentation

Report observed behavior, expected behavior, editor/plugin versions, and an original minimal reproduction. For tool
failures, include operation options, completion status, and a sanitized log excerpt. For performance, include actual
words, scene sizes, command density, useful-response latency, and combined runtime RSS.

Keep public documentation in `docs/`, small regressions in package tests or `fixtures/`, and local investigation output
under ignored `.bifoil-choicescript/development/`. Do not commit private game sources, corpus names, audit transcripts,
machine-specific paths, generated installers, or logs. Use the public identity **Chinay** in public material.

See [reporting a problem](docs/troubleshooting.md#reporting-a-problem) for the information that helps a maintainer
reproduce an issue without your whole game.

## Pull requests and validation

Lead with the concrete problem and resulting behavior. Include relevant validation and material limitations. Record
which source revision, package, editor, product, and platform were actually exercised. Do not equate source tests,
Plugin Verifier, native LSP transport, and manual UI acceptance.

Performance changes must preserve correctness and satisfy the [measurement contract](docs/performance.md). The current
resource and large-game targets remain unmet; a fast empty/stale/error response is not an improvement that passes
acceptance.

If packaging is in scope, rebuild affected artifacts after source changes. Follow [releasing](docs/releasing.md);
building a package is separate from publishing it.

## Licensing and scope

Original code is MIT licensed. The engine, template, Node.js, and other dependencies retain their own notices. Do not
modify vendored engine source or replace its license with this project's license. A deliberate dependency/runtime/engine
update must update pins, provenance, notices, and applicable validation together.

The planned Bifoil language, compiler, runtime, SDK, and studio are separate projects. Keep this checkout standalone; do
not add build dependencies on sibling repositories or private development workspaces.
