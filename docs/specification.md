# Language and release contract

This repository implements an independent, shared TypeScript language service and game-tooling layer, with VS Code and Kotlin/JetBrains adapters. All ranges use UTF-16. Commands and token categories have shared metadata; editor fallbacks are line-local. LSP is the editing interface and the custom tooling protocol is version 1.

## Required dialogue regression

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

The opening dialogue and both branch suffixes are dialogue. Commands, the variable, operator, and `"male"` keep code styling. Each alternative starts from the conditional's incoming quote state; sibling exits never feed each other. Following narrative is outside dialogue, with no quote warnings. Expression strings must close on their physical line and never change narrative state, even when malformed.

The regression suite extends this contract to nested alternatives, elseif, missing else, branch-opened quotes, paragraphs, straight and curly double quotes, scene transitions, subroutines and recursion, unknown generated text and destinations, arrays and indirect references, scope and assignments, escaped expression quotes, interpolation, multireplace, markup, CRLF, Unicode offsets, malformed indentation, incremental edits, and large graphs. Reachable analysis paths are conservatively approximated; uncertainty alone is not a definite quote error.

## Tooling contract

Project detection uses startup files or explicit configuration without globally claiming text files. Jobs carry protocol version, project and job IDs, options, progress/output, source positions, available coverage, staleness, and completion status. Editor buffers are snapshotted before staging. Official runtime tools run in child processes using the bundled Node executable; all owned processes and staging directories are cleaned up. Export preserves destination files. Trust gates execution but does not disable editing.

## Acceptance gates

Release verification includes core differential/regression tests; real LSP and official tool integration tests; both runtime outcomes of the required fixture; editor classification parity and theme checks; navigation/rename/project detection; embedded preview and browser fallback; seeded tests, cancellation and coverage; six self-contained runtime packages; spaces and Unicode in paths; Plugin Verifier for declared IDE builds; and a clean standalone build. Unrun OS/CPU or IDE/product checks must be identified in the validation record rather than claimed as passes.
