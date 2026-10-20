# Diagnostic reference

Bifoil ChoiceScript reports parser/analysis diagnostics, optional narrative warnings, project configuration problems,
and source failures from official test runs. These sources answer different questions.

Editor syntax diagnostics do not execute your game. QuickTest and RandomTest use a staged snapshot and may identify
runtime problems that static analysis cannot. A clean Problems view is not a release-readiness certificate.

## Read a diagnostic

Language diagnostic codes are listed below. Ordinary language errors use the `ChoiceScript` source; narrative warnings
use `ChoiceScript dialogue` and warning severity. Ranges follow zero-based UTF-16 internally, while editors display
familiar one-based line numbers.

Fix the earliest structural or expression error first: later messages can be consequences of an incomplete block or
argument. While typing, temporary diagnostics are expected. If an error remains after the source is corrected, see
[stale results](troubleshooting.md#stale-results-or-project-membership).

## Expression and substitution errors

| Code                     | What it means                                                                     | What to check                                                                  |
|--------------------------|-----------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| `expression-string`      | An expression string reaches the end of its physical line without a closing quote | Close the string on that line; narrative dialogue follows different rules      |
| `expression-smart-quote` | A curly quote occurs in an expression                                             | Use straight `"` delimiters in code                                            |
| `expression-character`   | A character is not recognized in this expression                                  | Accidental punctuation, a trailing colon, or copied rich-text characters       |
| `expression-syntax`      | The parsed expression is incomplete or structurally invalid                       | Values, grouping, operators, and argument boundaries                           |
| `expression-reference`   | A variable target was parsed as a function-like construct                         | Assignment target syntax; known built-in-name edge cases may need a bug report |
| `interpolation-close`    | A substitution lacks a closing brace on the same line                             | Complete the substitution before the line break                                |
| `multireplace-options`   | Multireplace lacks its expression/alternatives or enough alternatives             | Use a form such as `@{has_key open\|locked}`                                   |

Example:

```choicescript
*set name "Mira
*set score 4
```

Only the first line's string is unterminated. The second directive must remain separately parsed. If it becomes part of
a string, that is an editor defect worth reporting with a minimal example.

## Commands and declarations

| Code                  | What it means                                                         | What to check                                             |
|-----------------------|-----------------------------------------------------------------------|-----------------------------------------------------------|
| `unknown-command`     | The command is absent from shared metadata                            | Spelling and whether it exists in the pinned runtime      |
| `command-syntax`      | A directive has no recognizable command name                          | Text immediately after `*`                                |
| `missing-variable`    | A variable-taking directive lacks its target                          | Add the variable name/reference                           |
| `variable-name`       | A declaration uses an invalid or reserved identifier                  | Use a nonreserved name starting with a letter             |
| `create-literal`      | `*create` does not have a simple accepted literal                     | Initialize with a number, boolean, or plain quoted string |
| `missing-value`       | `*create`, `*set`, or `*setref` lacks its value                       | Add the value expression                                  |
| `missing-expression`  | An expression-taking command has an empty expression                  | Add the condition or value                                |
| `unexpected-argument` | Extra text follows a command that rejects it here                     | In particular, nothing follows `*else`                    |
| `duplicate-symbol`    | A symbol conflicts with an existing declaration in the analyzed scope | Duplicate variable or label names                         |
| `missing-target`      | A literal jump destination cannot be found                            | Label spelling, scene name, and project discovery         |

This list is not a complete catalogue of runtime errors. Some directives are recognized and documented without
exhaustive static validation of every argument or hosted-service behavior.

## Indentation and blocks

| Code                     | Meaning                                                                                  |
|--------------------------|------------------------------------------------------------------------------------------|
| `indentation-whitespace` | Nonblank indentation contains whitespace other than a space or tab                       |
| `mixed-indentation`      | Tabs and spaces are mixed, within indentation or across the document's indentation style |
| `orphan-alternative`     | `*else` / `*elseif` / `*elsif` has no matching preceding conditional at its indentation  |
| `unexpected-indent`      | A child line appears beneath a construct that does not accept a block                    |
| `missing-block`          | A block-taking command has no nonblank child content                                     |

Align alternatives with their `*if`. Align choice option markers with one another and indent option bodies beneath them.
A comment-only conditional body is allowed. Blank lines, including Unicode whitespace-only lines, do not end a block.

## Narrative warnings

| Code                     | Meaning                                                       | Typical response                                                           |
|--------------------------|---------------------------------------------------------------|----------------------------------------------------------------------------|
| `quote-branch`           | Known reachable paths disagree about narrative quote state    | Check every alternative, including a skipped path when there is no `*else` |
| `quote-unexpected-close` | A closing narrative quote has no matching known opening state | Check curly-quote direction and the incoming story path                    |
| `quote-unclosed`         | Dialogue is still open at the end of a resolved story path    | Find the intended closing quotation along that path                        |

These warnings follow English double-quote conventions. An apostrophe is not a dialogue delimiter. An expression's
`"value"` does not close a surrounding narrative quote.

Do not close a valid multi-line dialogue merely to eliminate a warning at a branch. First inspect the
[branch-state rules](specification.md#dialogue-across-branches), especially whether all paths really continue.
Unknown/generated state alone should remain neutral, not become a definite unmatched-quote error.

## Configuration and game-tool failures

Configuration diagnostics point to `choicescript.json` for malformed JSON and invalid known fields. A valid path
pointing at the wrong directory may instead cause no project to be detected.

Official test output is parsed into locations only where it refers to a known scene. Compiler/runner/process failures
without a reliable scene location stay in the output panel or log. Tool diagnostics belong to a job snapshot and become
stale after edits.

A cancelled run is not a successful test. A memory failure, incomplete index, or request timeout also does not establish
that the source is valid. Review [known limitations](known-limitations.md) when the output indicates a tooling failure
rather than a ChoiceScript error.
