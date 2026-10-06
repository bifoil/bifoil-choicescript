# Configure Bifoil ChoiceScript

Most games need no configuration. A scene directory containing `startup.txt` is detected automatically, including inside an existing engine checkout. Project configuration controls paths and test defaults; editor settings control presentation.

## Project layout

Place an optional `choicescript.json` in the game root:

```json
{
  "scenes": "scenes",
  "assets": ".",
  "randomtest": {
    "iterations": 1000,
    "seed": 0
  }
}
```

| Key                     | Default    | Meaning                                                                 |
| ----------------------- | ---------- | ----------------------------------------------------------------------- |
| `scenes`                | `"scenes"` | Directory containing `startup.txt` and scene `.txt` files               |
| `assets`                | `"."`      | Game asset directory copied into the staged game for preview and export |
| `randomtest.iterations` | `1000`     | Initial iteration value in the RandomTest dialog                        |
| `randomtest.seed`       | `0`        | Initial seed value in the RandomTest dialog                             |

Use paths relative to the configuration file. For example, an engine checkout can use `"scenes": "web/mygame/scenes"` and `"assets": "web/mygame"`. Keep `assets` focused on the game's assets rather than a parent directory containing unrelated projects.

The configured scenes directory must contain `startup.txt`. Bifoil ChoiceScript treats a configured root as one game and stops descending into it to discover more games; put a separate configuration in each game folder rather than one configuration above several games.

Without configuration, a directory named `scenes` uses its parent as the game root and asset directory. Other directories containing `startup.txt` use that directory as their root. Discovery scans workspace folders up to eight directory levels and skips hidden and common dependency/build directories. Open a game nearer its root or configure it explicitly if it is nested more deeply.

## RandomTest defaults

The values in `choicescript.json` prefill the editor dialogs; changing a value for one run does not rewrite the file. Iterations must be an integer from 1 to 10,000,000. The shared runner accepts safe-integer seeds, while the JetBrains dialog accepts signed 32-bit integers; stay in that range when sharing settings between editors.

## Narrative warnings

Narrative quote warnings are enabled by default. They flag inconsistent quotation across known paths and provably unclosed dialogue. They are separate from expression syntax diagnostics.

In VS Code settings:

```json
{
  "bifoil.choicescript.quoteWarnings": false
}
```

In JetBrains IDEs, toggle **Tools → Bifoil ChoiceScript → Narrative Quote Warnings**. This setting is stored per project. Disabling warnings does not disable dialogue highlighting or expression syntax diagnostics.

## Colors and semantic highlighting

Colors derive from the active editor theme. The shared analyzer emits these categories:

| Content                                  | Semantic token types                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| Commands, comments, operators, functions | `keyword`, `comment`, `operator`, `function`          |
| Literal values                           | `string`, `number`, `boolean`                         |
| Variables with known types               | `stringVariable`, `numberVariable`, `booleanVariable` |
| Mixed or unknown variables               | `variable`                                            |
| Scene and label references               | `label`                                               |
| Prose and dialogue                       | `narrative`, `dialogue`                               |
| Text formatting and substitutions        | `markup`, `interpolation`                             |

Modifiers include `declaration`, `readonly`, `bold`, and `italic`. A token's classification is shared; the resulting color depends on each editor's theme.

### VS Code

Semantic highlighting is enabled by default for ChoiceScript. Customize token styles with `editor.semanticTokenColorCustomizations`; for example, this adds italics to dialogue without fixing its foreground color:

```json
{
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "dialogue:choicescript": {
        "italic": true
      }
    }
  }
}
```

For theme-specific foreground rules and selectors, see the [VS Code semantic highlighting guide](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide). Check custom colors in both light and dark themes.

Bifoil ChoiceScript defaults to spaces with a two-space indent. Automatic quick suggestions are disabled for ChoiceScript; invoke completion manually or override the `[choicescript]` editor settings if you prefer automatic suggestions.

### JetBrains IDEs

Open **Settings → Editor → Color Scheme → Bifoil ChoiceScript** to customize token categories. Styles inherit from the active scheme, including bold and italic formatting.

## File associations

Automatic association applies to `.txt` files within discovered scene directories. Other text files retain their existing language. Use the editor's explicit language/file-type selection for a standalone scene; a global `*.txt` association would apply ChoiceScript rules to unrelated documents.
