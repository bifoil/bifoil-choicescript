# Language behavior

Bifoil ChoiceScript's shared analyzer supplies the same classifications and diagnostics to both editors. It follows the pinned ChoiceScript interpreter and recovers from incomplete input while you write. This guide describes the editor's behavior; narrative quote warnings do not add rules to ChoiceScript itself.

## Commands, expressions, and prose

The parser distinguishes commands, expressions, narrative lines, choice options, and indentation-based blocks. Arrays, indirect references, interpolation, multireplace, and Fairmath are analyzed using the pinned engine's syntax.

Expression strings end at a closing quote or recover at the physical end of their line. An unterminated string produces a local diagnostic. Parsing resumes on the next line without carrying the expression's string state into another command or into prose.

All source positions use UTF-16 offsets, matching LSP and JavaScript strings. This applies to tokens, diagnostics, and navigation, including CRLF input and characters outside the Basic Multilingual Plane.

## Dialogue follows control flow

Narrative double quotes have their own state. That state can continue across paragraphs, commands, resolvable jumps, scene transitions, and subroutine calls. Straight and curly double quotes are supported under English dialogue conventions; apostrophes are punctuation. Repeated opening quotes at continued-dialogue paragraphs are recognized.

A string inside a command or interpolation does not open or close the surrounding dialogue. Entering a command, reaching a newline, or starting an alternative does not reset narrative quotation.

### Conditional branches

Every alternative begins with the quote state that reached the conditional. A sibling branch never inherits another sibling's ending state.

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

The expected classifications are:

| Text                                    | Classification                                    |
| --------------------------------------- | ------------------------------------------------- |
| `She said `                             | Ordinary narrative                                |
| `"This is the end,`                     | Dialogue                                          |
| `*if`, `gender`, `=`, `"male"`, `*else` | Their respective command/expression categories    |
| `William."` and `Belle."`               | Dialogue; each closes its inherited opening quote |
| `She walked away.`                      | Ordinary narrative                                |

There are no unmatched-dialogue warnings for this example. `implicit_control_flow` permits the branches to fall through to the following narrative. Directives do not use trailing colons.

At a join, Bifoil ChoiceScript merges reachable continuation states. If all paths close the quote, following text is outside dialogue. If known paths disagree, uncertain text receives neutral styling and narrative warnings can identify the inconsistency. Without an `*else`, the path that skips the conditional also participates in the merge.

### Jumps, calls, and uncertainty

Resolvable destinations propagate quotation across labels, scenes, and subroutine calls. Loops and recursive calls are analyzed to a fixed point rather than treated as a single linear pass. Scene transitions do not automatically close dialogue.

Dynamic destinations and generated text can make the state unknown. Bifoil ChoiceScript styles text as dialogue only when the incoming states agree. Unknown state alone is not evidence of a quote error. Consequently, some dialogue can remain neutrally styled when the analyzer cannot prove how execution reaches it.

Narrative warnings report provable problems, not every opening quote at the end of a line. You can [disable those warnings](configuration.md#narrative-warnings) independently of syntax diagnostics and highlighting.

## Variable types and navigation

Type inference uses assignments and control flow at each reference. Known strings, numbers, and booleans receive their respective variable styles. Reassignment can change the style later in a scene; branch merges, arrays, scope, indirect references, and coercions affect the inferred value.

When values have mixed or unknown types, the variable keeps neutral styling. A variable name alone does not determine its type.

Definitions, references, and rename operate on resolved symbols. Rename avoids narrative text and unresolved dynamic references. This can leave a dynamic reference unchanged when its destination cannot be proven; inspect such references when renaming a symbol used indirectly.

## Highlighting layers

Expressions and markup take precedence over surrounding prose spans. This keeps interpolation, multireplace, markup delimiters, and command arguments readable inside dialogue, without overlapping semantic tokens.

Fallback highlighting is deliberately line-local: TextMate in VS Code and a minimal lexer in JetBrains. It provides basic syntax colors while the language service starts or is unavailable. Cross-line quotation and branch-dependent variable colors require semantic analysis; a regex string region is not used to consume narrative across commands.

## Limits

Static analysis does not execute game code or prove every runtime path correct. Dynamic values, generated text, and unresolved destinations reduce precision. Use official [QuickTest and RandomTest](usage.md#quicktest-and-randomtest) alongside editor diagnostics.

The [regression suites](testing.md) exercise these behaviors with small synthetic scenes and the pinned interpreter. When changing the analyzer, preserve both the classifications and the recovery behavior of incomplete input.
