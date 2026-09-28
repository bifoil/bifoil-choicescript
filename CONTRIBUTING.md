# Contributing to Branchlight

Branchlight is an independent personal project maintained by chinay. Contributions should keep the shared language service consistent across VS Code and JetBrains IDEs and preserve normal editing when game tooling is unavailable.

For a bug, start with [a minimal reproduction](docs/troubleshooting.md#reporting-a-problem). For a substantial feature or compatibility change, open an issue describing the user problem and proposed behavior before building it. Issues and pull requests currently require access to the private repository.

## Build from source

You need Git, Node.js 24, and the pnpm version declared in [package.json](package.json). CI uses Node.js 24.21.0 and pnpm 12.6.0. The JetBrains adapter additionally requires JDK 21; use the checked-in Gradle wrapper. Python is not a build dependency; use `uv` if a maintenance task needs Python.

Clone with the engine submodule and preserve its original line endings, including on Windows:

```sh
git -c core.autocrlf=false clone --recurse-submodules https://github.com/Chinay-Domitrix/branchlight.git
cd branchlight
git config core.autocrlf false
pnpm install --frozen-lockfile
pnpm check
```

For an existing clone that lacks the engine:

```sh
git -c core.autocrlf=false submodule update --init --recursive
```

`pnpm check` verifies the engine revision and checksums, builds the TypeScript bundles, checks types, and runs the shared regression and integration suites. The build uses this checkout and its dependencies; no other ChoiceScript checkout is required.

Dependency build permissions are declared in [pnpm-workspace.yaml](pnpm-workspace.yaml). Keep the lockfile and those permissions under review when updating dependencies. Do not replace them with a blanket approval of install scripts.

## Find the right component

| Directory             | Responsibility                                                      |
| --------------------- | ------------------------------------------------------------------- |
| `packages/core`       | Parsing, control flow, dialogue and type analysis, editing features |
| `packages/server`     | LSP, workspace snapshots, analysis workers, editor requests         |
| `packages/protocol`   | Shared game-tool request and event contracts                        |
| `packages/tooling`    | Project discovery, staging, preview, official test runners, export  |
| `editors/vscode`      | VS Code commands, presentation, and extension packaging metadata    |
| `editors/intellij`    | Kotlin adapter using JetBrains' native LSP integration              |
| `scripts`             | Generation, builds, packaging, provenance, and verification         |
| `fixtures`            | Small, original regression examples                                 |
| `vendor/choicescript` | Unmodified upstream engine, pinned as a Git submodule               |

Read [architecture](docs/architecture.md) for the boundaries between these components and [language behavior](docs/specification.md) before changing analysis. Shared command metadata lives in `packages/core/src/commands.json`; regenerate derived editor files with `pnpm generate`.

## Work on an editor adapter

For a local VS Code installer, after `pnpm check`:

```sh
pnpm package:vscode
```

Install the resulting `dist/packages/branchlight-<platform>-<arch>.vsix` through **Extensions: Install from VSIX**. This command packages the current host platform by default.

For a JetBrains development build, prepare only the current host runtime first:

```sh
pnpm package:intellij --current
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

On Windows without a Bash shell, use `editors\intellij\gradlew.bat -p editors/intellij test buildPlugin verifyPlugin`. The resulting ZIP is under `editors/intellij/build/distributions/`. A build prepared with `--current` is for local use; release packages require all six runtimes.

IDE SDKs and Plugin Verifier downloads can be large. Start with one product and the checks relevant to your change. See [testing](docs/testing.md) for editor smoke tests and [packaging and releases](docs/releasing.md) for distribution builds.

## Prepare a change

- Keep language semantics in the shared core. Editor adapters should translate requests and present results.
- Add a focused regression for a behavior change, using a small original scene. Preserve UTF-16 ranges, recovery after malformed input, and agreement between editor classifications.
- Keep upstream engine files unchanged. Engine updates must deliberately update the submodule pin, provenance, checksums, and related tests together.
- Write idiomatic Kotlin and use the repository's TypeScript and Prettier configuration. Avoid packing multiple Kotlin statements onto one line.
- Update the relevant public guide when behavior, configuration, or installation changes.

Run the appropriate checks from [testing](docs/testing.md), then review `git diff --check` and the final diff. The repository's source-format command is `pnpm format`; it does not include Markdown. Format documentation explicitly:

```sh
pnpm exec prettier --write README.md CONTRIBUTING.md THIRD_PARTY_NOTICES.md "docs/*.md"
```

A pull request should explain the problem, the resulting behavior, and the checks run. Note platform checks that were not run. Keep unrelated dependency upgrades, generated artifacts, and local editor settings out of the change.

## Documentation and local material

`docs/` is public documentation: user guides, contributor references, and release information. Regression inputs belong in `fixtures/` or package tests. Local reports, exploratory measurements, logs, and development notes belong in ignored `.branchlight/development/`, not public guides.

Use original synthetic examples in committed fixtures and documentation. Keep external game sources and their identifying details out of the repository. [Read-only corpus analysis](docs/testing.md#analyze-local-scenes) is available for local investigation without copying those files into the project.

Original contributions are covered by the project's [MIT license](LICENSE). Preserve all upstream licenses and notices when changing packaging.
