# Bifoil ChoiceScript

ChoiceScript authoring tools for VS Code and JetBrains IDEs, built around one shared language service.

**An unofficial personal project under the planned Bifoil Foundation umbrella, maintained by Chinay.
Unaffiliated with Choice of Games or upstream ChoiceScript.**

[Installation](docs/support.md) · [First game](docs/getting-started.md) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

## What you can do

- Write with completion, command documentation, navigation, references, rename, folding, and semantic highlighting.
- Follow dialogue through conditional branches independently of quoted strings in commands.
- See inferred string, number, and boolean variable types at individual references.
- Create projects from the pinned upstream template, preview games, run official QuickTest and seeded RandomTest,
  and export HTML with companion assets.
- Open existing games without associating every unrelated `.txt` file with ChoiceScript.

For example, the dialogue in these two alternatives closes independently:

```choicescript
*create gender "male"
*create implicit_control_flow true
She said "This is the end,
*if gender = "male"
    William."
*else
    Belle."
She walked away.
```

The quoted expression `"male"` keeps its code styling. Both branch endings receive dialogue styling, and the following
sentence is ordinary narrative. An unfinished expression string is an error on its own line; it does not absorb later
commands or reset the surrounding dialogue. Read the [language guide](docs/specification.md) for details.

## Current status

This repository is in **private prerelease development**. Access to the repository is required for builds and issues.
There is no marketplace release. Implemented features are not a claim that every editor, platform, or workload has
passed acceptance.

The current version has [known limitations](docs/known-limitations.md), including rename edge cases, unreliable
JetBrains coverage delivery, and incomplete large-game support. The targets of **256 MiB combined plugin runtime
memory**, **responses below one second**, and **games with tens of millions of words** are not yet met across required
workloads. See [performance and scale](docs/performance.md) before relying on those limits.

| Editor                           | Declared baseline | Package                            |
| -------------------------------- | ----------------- | ---------------------------------- |
| VS Code desktop                  | 1.109+            | OS- and architecture-specific VSIX |
| IntelliJ IDEA, WebStorm, PyCharm | 2026.1.4          | JetBrains plugin ZIP               |

Packaging targets Windows, macOS, and glibc-based Linux on x64 and ARM64. Packages include Node.js 24 and an unmodified,
pinned ChoiceScript engine; users do not need to install Node.js. Exact JetBrains build requirements and exclusions are
in [compatibility](docs/jetbrains-compatibility.md). Browser-only VS Code, Android Studio, debugging, and marketplace
publication are outside the first release.

## Start writing

1. [Install a package](docs/support.md) for your editor and host.
2. Open a game folder containing `scenes/startup.txt`, or invoke **Bifoil ChoiceScript: New Project** in VS Code /
   **Tools → Bifoil ChoiceScript → New Project** in JetBrains.
3. Open a scene. Use your editor's completion, hover, navigation, and Problems UI.
4. In a trusted project, choose **Run Game**, **Run QuickTest**, or **Run RandomTest**.
5. Follow the [first-game walkthrough](docs/getting-started.md) for a complete example.

Existing engine checkouts and multiple games are supported through [project discovery](docs/projects.md).
Paths and test defaults go in `choicescript.json`; presentation belongs in [editor settings](docs/configuration.md).

## Find your way around

| I want to…                                 | Read                                                                |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Write and navigate a story                 | [Authoring guide](docs/usage.md)                                    |
| Preview, test, inspect coverage, or export | [Game tools](docs/game-tools.md)                                    |
| Understand a diagnostic                    | [Diagnostic reference](docs/diagnostics.md)                         |
| Fix detection, colors, or a failed run     | [Troubleshooting](docs/troubleshooting.md)                          |
| Build or change the plugin                 | [Contributing](CONTRIBUTING.md), [development](docs/development.md) |
| Understand the shared service              | [Architecture](docs/architecture.md), [protocol](docs/protocol.md)  |
| Package and validate a candidate           | [Testing](docs/testing.md), [releasing](docs/releasing.md)          |

The [documentation index](docs/README.md) links every guide. For reports, provide an original minimal example and
versions, following [reporting a problem](docs/troubleshooting.md#reporting-a-problem).

## Bifoil and licensing

Bifoil Foundation is the planned umbrella for a broader interactive-fiction ecosystem. This repository implements
ChoiceScript editor tooling; a future Bifoil language, compiler, runtime, SDK, and studio are separate plans.
The name does not imply incorporation, nonprofit status, or upstream affiliation.

Original code is [MIT licensed](LICENSE). The bundled ChoiceScript engine, official template, Node.js, and dependencies
retain their own licenses and notices. See [third-party notices](THIRD_PARTY_NOTICES.md); this project's MIT license
does
not replace the ChoiceScript license.
