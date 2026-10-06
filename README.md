# Bifoil ChoiceScript

ChoiceScript authoring tools for VS Code and JetBrains IDEs.

Bifoil ChoiceScript helps you write, navigate, preview, and test branching stories. Both editor plugins use the same language service, so dialogue, variables, and diagnostics are analyzed consistently across editors.

**An unofficial personal project by chinay, unaffiliated with Choice of Games or upstream ChoiceScript.**

[Get started](docs/support.md) · [User guide](docs/usage.md) · [Configuration](docs/configuration.md) · [Contributing](CONTRIBUTING.md)

## What it does

- **Understands dialogue across branches.** Narrative quotation is tracked through conditionals, scenes, and subroutines independently of strings in commands. An unfinished command string cannot consume the next line.
- **Highlights what the code means.** Variables receive string, number, or boolean styling where their type can be inferred. Uncertain values keep neutral styling; colors follow your editor theme.
- **Supports everyday editing.** Completion, hover documentation, definitions, references, rename, symbols, folding, selection ranges, snippets, and narrative word counts.
- **Runs your game from the editor.** Create a project, open a preview, run official QuickTest or seeded RandomTest, inspect available coverage, and export HTML with companion assets.

For example, these two branches each close the same opening dialogue quote:

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

Both `William."` and `Belle."` receive dialogue styling. The command expression `gender = "male"` keeps its code styling, and `She walked away.` is ordinary narrative. See [language behavior](docs/specification.md) for the rules and limits of this analysis.

## Get started

Bifoil ChoiceScript is in private prerelease development. Repository access is required to download builds or open issues; it is not published to an editor marketplace.

| Editor                           | Supported baseline | Installer                                |
| -------------------------------- | ------------------ | ---------------------------------------- |
| VS Code desktop                  | 1.109+             | A VSIX for your operating system and CPU |
| IntelliJ IDEA, WebStorm, PyCharm | 2026.1.4           | The JetBrains plugin ZIP                 |

Packages include Node.js and the pinned ChoiceScript engine. You do not need a separate Node.js installation to use them. Windows, macOS, and Linux packages cover x64 and ARM64; Linux requires glibc. See [installation](docs/support.md) for download instructions and [JetBrains compatibility](docs/jetbrains-compatibility.md) for exact builds.

1. Install the plugin for your editor.
2. Open a game folder containing `scenes/startup.txt`, or use **Bifoil ChoiceScript: New Project** in VS Code / **Tools → Bifoil ChoiceScript → New Project** in a JetBrains IDE.
3. Open a scene and start writing. Bifoil ChoiceScript recognizes scene files without claiming every `.txt` file in your workspace.
4. Use **Run Game** to preview, then **Run QuickTest** or **Run RandomTest** to test. Execution requires a trusted workspace; editing assistance remains available without it.

## Documentation

- [User guide](docs/usage.md): editing, preview, testing your game, and export.
- [Configuration](docs/configuration.md): project layouts, warnings, and colors.
- [Troubleshooting](docs/troubleshooting.md): detection, installation, and tooling problems.
- [Development guide](CONTRIBUTING.md): build from source and contribute a change.
- [Documentation index](docs/README.md): architecture, APIs, compatibility, and release procedures.

The [release notes](docs/release-notes.md) describe the current candidate and its remaining limitations. For a bug report, include a small reproducible example and your editor and plugin versions; see [reporting a problem](docs/troubleshooting.md#reporting-a-problem).

## License

Original Bifoil ChoiceScript code is [MIT licensed](LICENSE). The bundled ChoiceScript engine and other dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). Bifoil ChoiceScript's license does not replace the license for ChoiceScript or its project template.
