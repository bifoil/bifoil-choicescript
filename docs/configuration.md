# Configuration reference

Project configuration controls file paths and RandomTest defaults. Editor settings control presentation. Most
conventional `scenes/startup.txt` projects need no configuration file.

## Project configuration

Place strict JSON in `choicescript.json` at the game root:

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

| Key                     | Type    | Default    | Meaning                                          |
| ----------------------- | ------- | ---------- | ------------------------------------------------ |
| `scenes`                | String  | `"scenes"` | Relative directory containing `startup.txt`      |
| `assets`                | String  | `"."`      | Relative root of game assets copied into staging |
| `randomtest`            | Object  | Omitted    | Optional test defaults                           |
| `randomtest.iterations` | Integer | `1000`     | Initial iteration count and runner fallback      |
| `randomtest.seed`       | Integer | `0`        | Initial random seed and runner fallback          |

Paths resolve relative to the config file. Absolute paths are rejected. Parent-relative paths are accepted, but external
scene roots may not receive all editor file-watch events. Use a dedicated asset directory if the root contains notes or
other material you do not intend to distribute.

For an engine checkout:

```json
{
  "scenes": "web/mygame/scenes",
  "assets": "web/mygame"
}
```

The configuration must be an object, without JSON comments or trailing commas. Unknown keys are currently ignored, not
validated as supported features. There is no published config schema in the repository. Invalid known fields produce
diagnostics; a valid config pointing to a nonexistent startup file simply fails to identify a project.

The bundled runner requires scenes directly in the scene directory. See [discovery rules](projects.md) before
configuring multiple games beneath one workspace.

## RandomTest defaults and ranges

Iterations must be from **1 to 10,000,000**, inclusive. A seed must be a safe integer from **−9,007,199,254,740,991 to
9,007,199,254,740,991**, inclusive. `seed + iterations - 1` must also fit that safe-integer range.

Editor inputs accept decimal integers, with an optional minus sign for seeds. They reject fractions, exponent notation,
leading/trailing spaces, and a leading plus sign. Changing dialog values affects that run; it does not rewrite
`choicescript.json`. Defaults apply to the runner too, not just the dialog.

These upper bounds validate arguments; they are not a promise that a game can complete that many iterations within a
particular resource or time budget.

## Narrative warnings

Warnings are on by default and separate from syntax errors. To disable them in VS Code:

```json
{
  "bifoil.choicescript.quoteWarnings": false
}
```

In JetBrains, toggle **Tools → Bifoil ChoiceScript → Narrative Quote Warnings**. The choice is stored per project.

Disabling warnings does not disable semantic dialogue styling or relax expression-string syntax. An unknown dialogue
state is not itself an error, regardless of the warning setting.

## VS Code editing defaults

The extension contributes these language-specific defaults:

```json
{
  "[choicescript]": {
    "editor.semanticHighlighting.enabled": true,
    "editor.quickSuggestions": {
      "other": false,
      "comments": false,
      "strings": false
    },
    "editor.insertSpaces": true,
    "editor.tabSize": 2
  }
}
```

You can override them through normal VS Code settings. Explicit completion works with quick suggestions disabled. Avoid
a global `*.txt` association; [project-aware association](projects.md#which-text-files-become-choicescript) is narrower.

## Colors and semantic tokens

Colors inherit from the editor theme. Token categories are shared, while each editor maps them to its native scheme.

| Category                                              | Meaning                                             |
| ----------------------------------------------------- | --------------------------------------------------- |
| `keyword`, `comment`                                  | Commands and comments                               |
| `string`, `number`, `boolean`                         | Expression literals                                 |
| `operator`, `function`                                | Expression operations and recognized functions      |
| `variable`                                            | A neutral, mixed, or unknown variable               |
| `stringVariable`, `numberVariable`, `booleanVariable` | A variable with one inferred type at this reference |
| `label`                                               | Label and scene-reference styling                   |
| `dialogue`, `narrative`                               | Known quoted dialogue and ordinary narrative        |
| `markup`, `interpolation`                             | Narrative markup and substitution delimiters        |

Modifiers are `declaration`, `readonly`, `bold`, and `italic`. They describe spans; not every theme renders every
modifier. Typed-variable categories inherit variable behavior with fallback scope mappings for their value types.
Dialogue has string-like fallback styling.

To customize colors for a dark theme in VS Code:

```json
{
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "dialogue:choicescript": "#CE9178",
      "stringVariable:choicescript": "#CE9178",
      "numberVariable:choicescript": "#B5CEA8",
      "booleanVariable:choicescript": "#569CD6",
      "*.bold:choicescript": {
        "bold": true
      },
      "*.italic:choicescript": {
        "italic": true
      }
    }
  }
}
```

These are example colors, not required defaults; check contrast against your own theme. In JetBrains use **Settings →
Editor → Color Scheme → Bifoil ChoiceScript**, including its executed-line coverage category. Test both light and dark
schemes when overriding styles.

## Command identifiers

These IDs are useful for user-defined keybindings and adapter tests. They are distinct from the server's
`bifoil.choicescript.server.*` commands described in the [protocol](protocol.md).

| Action         | VS Code command                     | JetBrains action                   |
| -------------- | ----------------------------------- | ---------------------------------- |
| New Project    | `bifoil.choicescript.createProject` | `BifoilChoiceScript.New`           |
| Run Game       | `bifoil.choicescript.run`           | `BifoilChoiceScript.Run`           |
| Stop           | `bifoil.choicescript.stop`          | `BifoilChoiceScript.Stop`          |
| QuickTest      | `bifoil.choicescript.quicktest`     | `BifoilChoiceScript.QuickTest`     |
| RandomTest     | `bifoil.choicescript.randomtest`    | `BifoilChoiceScript.RandomTest`    |
| Export         | `bifoil.choicescript.exportHtml`    | `BifoilChoiceScript.Export`        |
| Word count     | `bifoil.choicescript.wordCount`     | `BifoilChoiceScript.Words`         |
| Bold           | `bifoil.choicescript.bold`          | `BifoilChoiceScript.Bold`          |
| Italic         | `bifoil.choicescript.italic`        | `BifoilChoiceScript.Italic`        |
| Quote warnings | Setting above                       | `BifoilChoiceScript.QuoteWarnings` |
| About          | `bifoil.choicescript.about`         | `BifoilChoiceScript.About`         |

There are no supported user settings for a custom engine executable, Node heap size, worker count, automatic preview
reload, or a performance-limit override. Changing project JSON does not configure those internals.
