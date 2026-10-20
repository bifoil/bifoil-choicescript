# Authoring guide

Open a detected scene or explicitly select the ChoiceScript language to use editing assistance. If detection is the
problem, start with [projects and files](projects.md). This page covers editing; execution is in
[game tools](game-tools.md).

## Completion and documentation

Request completion with your editor's normal completion action. VS Code disables automatic quick suggestions for
ChoiceScript by default so ordinary prose does not continually open a popup; explicit completion remains available.

| Context                                             | Suggestions                             |
| --------------------------------------------------- | --------------------------------------- |
| A directive beginning with `*`                      | Known commands from the shared metadata |
| `*goto ` or `*gosub `                               | Labels in the current scene             |
| `*goto_scene `, `*gosub_scene `, `*redirect_scene ` | Discovered scenes                       |
| Command expressions and unfinished substitutions    | Known global and scene-local variables  |
| Ordinary narrative                                  | No general prose completion             |

Completion is assistance, not proof that an offered symbol is valid on every control-flow path. Hover over a command to
see its documentation and upstream source link. Hover over a resolved variable for symbol and inferred-type information.
Some values remain unknown until the current project analysis is ready.

## Navigation, references, and rename

Use the editor's **Go to Definition**, **Find References**, **Rename**, document outline, and workspace symbol search.
Navigation uses resolved code symbols rather than searching the prose for matching text. You can navigate to literal
label and scene destinations. Runtime-generated names may not be resolvable.

Rename requires a current project index. It rejects invalid identifiers and many namespace collisions, including
declared variables, generated array elements, and parameters. Scene/file rename is not implemented through symbol
rename. Dynamic references that cannot be proven are not guessed.

**Review the edit preview.** Known prerelease defects affect some special identifiers, stat-chart text, and shadowed
bindings. Keep a recoverable source revision before broad renames, inspect indirect uses, and rerun official tests. See
[known limitations](known-limitations.md#language-analysis-and-rename). An incomplete-index or document-changed error
means the operation did not have a current basis; retry after analysis settles.

## Highlighting

Semantic highlighting distinguishes commands, comments, expression strings, numbers, booleans, operators, functions,
labels, variable types, interpolation, markup, narrative, and dialogue.

A variable's type comes from assignments reaching that reference. A variable can therefore change color later in a
scene. Mixed or unknown types use neutral variable styling. Narrative dialogue can remain open across commands and
branches; expression quotes never change that narrative state.

The editor also has a conservative fallback lexer. Fallback colors appearing during startup are not full control-flow
analysis. Theme settings control the actual colors; use [configuration](configuration.md#colors-and-semantic-tokens) to
customize them and [language behavior](specification.md) to understand classifications.

## Indentation, comments, folding, and selections

Use consistent indentation, normally spaces. VS Code defaults to two spaces for ChoiceScript. Branch directives and
their alternatives align; their contents indent beneath them. The plugin offers indentation assistance, not a complete
ChoiceScript document formatter.

The editor's line-comment action uses `*comment`. Fold ranges follow indented child blocks. Semantic selection expands
from a token to its line and then the document; it is not a full sequence of every nested expression node.

Do not append Python-style colons to directives:

```choicescript
*if has_key
  The door opens.
*else
  The door stays shut.
```

Whether these branches may fall through depends on runtime control-flow rules, including `implicit_control_flow`. Syntax
coloring alone does not establish that the surrounding game will execute successfully.

## Snippets and live templates

VS Code's supplied snippets use these prefixes:

| Prefix    | Inserts                              |
| --------- | ------------------------------------ |
| `if`      | An `*if` / `*else` block             |
| `choice`  | Two options with placeholder endings |
| `create`  | A variable declaration               |
| `display` | A variable substitution              |

JetBrains live templates are `csif` and `cschoice`, under the ChoiceScript context. Use the editor's snippet/template
expansion action and replace placeholders. A scaffold may require explicit jumps or `implicit_control_flow` before it is
valid in your game.

## Bold and italic text

**Bold Selection** wraps selected text in `[b]…[/b]`; **Italicize Selection** uses `[i]…[/i]`. These are wrapping
actions, not formatting toggles: applying them again can nest tags instead of removing existing ones. VS Code applies
the action to each selection. Empty selections insert an empty pair of tags.

The semantic layer applies bold/italic modifiers where supported. The game runtime, rather than the editor, determines
the final rendered appearance.

## Narrative word counts

**Show Narrative Word Count** reports the active scene's analyzed narrative count. It is a source-oriented estimate, not
the number of words in one player's playthrough.

The analyzer counts prose, option text, and recognized inline narrative. It removes bracketed markup, then counts
Unicode letter/number runs with supported internal apostrophes. Alternate passages contribute even when a single
playthrough would not see all of them. Substitution expressions and generated text make source counts different from
rendered counts; `*print` output cannot generally be counted statically.

The UI command is not a whole-game word-count dashboard. Integrators can read aggregate indexed counts from
`choicescript/indexStatus`, subject to incomplete-index limits.

## Editor actions

In VS Code, search the Command Palette for **Bifoil ChoiceScript**. In JetBrains, use **Tools → Bifoil ChoiceScript** or
Find Action.

| Action                               | Purpose                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| New Project                          | Copy the pinned official template into a new/empty directory |
| Run Game                             | Start or restart a staged preview                            |
| Stop Game or Tests                   | Stop game tooling for the selected project                   |
| Run QuickTest                        | Run the official structural test                             |
| Run RandomTest                       | Run seeded sampled playthroughs                              |
| Export HTML                          | Compile to a selected destination with companion assets      |
| Show Narrative Word Count            | Count the current scene                                      |
| Bold Selection / Italicize Selection | Insert ChoiceScript markup                                   |
| Narrative Quote Warnings             | JetBrains toggle; VS Code uses a setting                     |
| About                                | Show product identity and independent status                 |

Language features such as rename and folding use normal editor actions rather than duplicate plugin commands. Command
identifiers are listed in [configuration](configuration.md#command-identifiers).
