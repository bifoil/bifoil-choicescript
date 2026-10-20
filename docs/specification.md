# Language behavior

This page describes Bifoil ChoiceScript's analysis model, not a replacement specification for the ChoiceScript runtime.
The source of runtime behavior is the pinned [upstream interpreter](../vendor/choicescript/web/scene.js) and its tests.
The editor supports incomplete source files and recovers from errors; successful highlighting does not prove a game is
valid.

See [diagnostics](diagnostics.md) for messages, [configuration](configuration.md) for colors and warnings, and
[known limitations](known-limitations.md) for current deviations and gaps.

## Source structure and recovery

The parser distinguishes commands, expressions, prose, choice options, comments, metadata, and command-specific blocks.
Indentation builds the block structure. Command names, including `*comment`, are case-insensitive. Directives do not
have trailing colons.

A malformed expression remains local to its physical line. The parser keeps enough structure to continue recognizing
later commands, prose, and branches. Mixed indentation, orphan alternatives, and missing blocks receive their own
diagnostics rather than silently changing subsequent text into a string.

Scene names retain filename case, including literal and computed jump destinations and scene-list entries.
`Act` and `act` can identify different scenes. Match filename case when moving or exporting a game across platforms;
variable and label names remain case-insensitive.

All ranges use **zero-based UTF-16 positions with exclusive ends**, matching LSP and JavaScript strings. A supplementary
Unicode character occupies two UTF-16 code units even though it is one Unicode code point. CRLF is one line break;
columns describe content on that line.

## Expressions

Quoted expression values use straight double quotes:

```choicescript
*create name "William"
*create courage 50
*create has_key false
*set courage %+ 10
*set name (name & " the Bold")
```

The analyzer handles literals, variable references, operators, recognized built-in functions, arrays, indirect
references, and command-specific argument forms. It tracks available values and coercions conservatively. Expression
grouping follows the pinned interpreter's rules; do not assume JavaScript operator precedence.

`%+` and `%-` are Fairmath operators, distinct from ordinary addition and subtraction. Arrays and indirect references
can create or resolve names that are not written literally at every use. For example, a known string target in `*setref`
can resolve to a variable, while an unknown string target may not.

```choicescript
*create score 10
*temp target "score"
*setref target +5
Your score is ${score}.
```

Interpolations such as `${name}` and multireplace expressions such as `@{has_key open|locked}` embed expression syntax
inside prose. Substitutions must close on the same physical line. Their delimiters and expressions retain code styling
inside dialogue. Display modifiers and escaped quotes are handled as part of their respective syntax.

Function-name and special-identifier edge cases remain; the implementation is not a complete proof of interpreter
equivalence. See [rename and language limits](known-limitations.md#language-analysis-and-rename).

## Expression strings and narrative dialogue are independent

An expression string must close on its own physical line:

```choicescript
*set name "William
The road continues.
```

The first line receives `expression-string`. The next line is prose. Recovery resets the expression lexer only; it does
not close, open, or reset any narrative dialogue surrounding that command.

Curly double quotes may be narrative punctuation, but they are not expression-string delimiters. Apostrophes and curly
apostrophes in prose are punctuation, not dialogue delimiters.

## Dialogue across branches

Narrative quotes may remain open across lines, paragraphs, commands, scene transitions, and subroutine calls. The quote
state follows reachable control flow rather than the source file's linear order.

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

| Span                      | Expected classification                             |
| ------------------------- | --------------------------------------------------- |
| `She said `               | Narrative                                           |
| `"This is the end,`       | Dialogue                                            |
| `*if` and `*else`         | Commands                                            |
| `gender`, `=`, `"male"`   | Typed variable, operator, expression string         |
| `William."` and `Belle."` | Dialogue, independently closing the inherited quote |
| `She walked away.`        | Narrative                                           |

This example has no unmatched-dialogue warning. The explicit `implicit_control_flow` setting lets execution continue
after a conditional branch at runtime. It does not change the syntax and is not an editor setting.

Every alternative begins with the state reaching the conditional. It never starts from its previous sibling's ending
state. At the join, only reachable continuation paths contribute. A missing `*else` contributes the path that skips the
conditional. A branch that jumps or terminates does not automatically fall through to its sibling.

If reachable paths disagree about quotation, following ambiguous text receives neutral styling and may receive a
`quote-branch` warning. A quote opened in every reachable branch can remain open after the join and close later. Nested
alternatives and `*elseif` use the same rule.

## Paragraphs, calls, and uncertainty

The default convention is English straight and curly double-quoted dialogue. A repeated opening quote at a continued
dialogue paragraph is recognized rather than blindly interpreted as a closing quote.

Resolvable `*goto`, scene transitions, and subroutine calls carry dialogue state across boundaries. Interprocedural
summaries and fixed-point iteration handle loops and recursive calls, subject to finite analysis budgets. Entering
another scene does not automatically reset the quote state.

Generated narrative and dynamic destinations can make the state unknown. Dialogue styling is applied only when the
incoming states establish it. Unknown state alone is not a definite quote error. Neutral text can therefore mean
insufficient evidence rather than ordinary narration proven on every path.

Warnings are separate from runtime syntax errors. An open quote at a newline or before a command is not, by itself, a
warning. A provably unfinished resolved story path can produce `quote-unclosed`. Disable these warnings independently
through [configuration](configuration.md#narrative-warnings).

## Types, scopes, and symbols

Type inference follows assignments at each reference, not just declarations. A known single type produces
`stringVariable`, `numberVariable`, or `booleanVariable`. Mixed or unknown values use `variable`. Branch joins retain
only information justified by incoming paths.

Globals, scene-local temporaries, parameters, generated array bindings, and indirect references affect lookup. An active
explicit binding can shadow a generated array name. Dynamic names and runtime inputs reduce precision. Known defects in
array handling and shadowing mean these rules are the model, not a guarantee for every construct.

Definitions and references use resolved symbols. Rename avoids guessing dynamic names and rejects many collisions, but
[known rename defects](known-limitations.md#language-analysis-and-rename) require reviewing proposed edits. Scene-file
renaming is outside symbol rename.

## Highlighting layers

The shared analyzer emits nonoverlapping semantic spans. Code and markup override narrative spans. Commands,
expressions, and interpolations remain legible while a narrative quote is open. Bold and italic tags add modifiers to
supported narrative spans.

VS Code's TextMate grammar and JetBrains' minimal lexer provide line-local fallback colors. They do not maintain
cross-line dialogue string regions. Branch-dependent quotation and variable types belong to semantic analysis.

The [architecture](architecture.md) explains compact closed-scene summaries and why partial or budget-limited analysis
cannot establish complete project-wide results. Use official tests and manual play alongside editor diagnostics.
