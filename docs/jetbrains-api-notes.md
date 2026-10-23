# Maintain the JetBrains adapter

The adapter owns native integration and UI; shared syntax and flow semantics live in the native Go core. Start with
[architecture](architecture.md), [protocol](protocol.md), and [compatible builds](jetbrains-compatibility.md).

## Source map

The Kotlin adapter starts in
[Integration.kt](../editors/intellij/src/main/kotlin/dev/bifoil/choicescript/Integration.kt), which owns the LSP connection.
The files below divide its remaining responsibilities.

| File                             | Area                                                  |
| -------------------------------- | ----------------------------------------------------- |
| `Integration.kt`                 | Native LSP support and custom protocol integration    |
| `Runtime.kt`                     | Bundled resources, verification, runtime launch setup |
| `Language.kt` / `Parsing.kt`     | Language/file association and native fallback parsing |
| `Highlighting.kt`                | Semantic/fallback colors                              |
| `Editing.kt`                     | Editing assistance                                    |
| `Ui.kt`                          | Actions, progress, output, preview, selection         |
| `Coverage.kt`                    | Coverage state and editor markers                     |
| `Options.kt` / `Cancellation.kt` | Input validation and cancellation classification      |
| `BifoilBundle.kt`                | Localized resource access                             |

Registration is in [plugin.xml](../editors/intellij/src/main/resources/META-INF/plugin.xml). Action labels and
live-template descriptions come from `messages.BifoilBundle`.

## Native LSP lifecycle

Use supported platform lifecycle hooks and the built-in LSP module. Do not override
`GeneralCommandLine.createProcess()`; it is non-extendable. Launch the bundled Go host with the same bundle/tooling arguments as VS Code. Release owned resources when the project or server session ends.

Tests that instantiate the descriptor and connect LSP4J directly bypass some native platform behavior. Add tests through
the native LSP manager and transport when changing startup, registration, callbacks, or disposal. A process launch and
an `initialize` response do not prove the plugin is correctly integrated into an editor.

## Wire DTOs and notifications

Keep Kotlin DTO field names, optionality, number ranges, and protocol version aligned with TypeScript. Source lines in
job events are zero-based; paths, URIs, and project IDs are not interchangeable.

LSP4J invokes custom callbacks through reflection. Scope `unused` suppressions to the callback methods that need them.
Discovery uses `ProjectsChangedParams`, a versioned object containing the project list. A root JSON array is interpreted
as positional arguments by LSP4J and does not match this callback. `ChoiceLanguageClient` is public and named so reflective
dispatch can invoke its annotated interface methods. The manager regression asserts delivery to the actual receiver.

The native platform synchronizes project content. Test fixtures must register their real directories as module content
roots; merely launching a manager for an unrelated external file does not establish document synchronization. Keep
standalone-file and project-root tests separate.

Subscribe before starting jobs because events can arrive before request completion. Progress must settle exactly once on
completion, rejected starts, cancellation, and lost server sessions. A helper that classifies cancellation is useful
only if production error-handling paths actually call it.

## UI thread and ownership

Keep I/O, large decoding work, and analysis off the EDT. Schedule native UI updates deliberately and measure their cost.
Coverage retains complete counts but creates highlighters only for visible logical rows, including folded/soft-wrapped
views. Refresh markers on viewport changes. Test real editor updates and scrolling alongside large count collections.

The game picker allows one selection. The narrative-warning toggle reads the project's mutable settings and requests
updates on the EDT. Keep the project's state in project services. Keep mutable parser state outside extension companion
objects.

Dispose of JCEF and browser resources when closing preview content, then stop the matching job. Project shutdown must
also settle progress and release resources. Check both normal closure and failed/cancelled starts.

## Themes and fallback syntax

Semantic keys inherit from the active editor scheme. Preserve scheme-derived colors while applying bold/italic
modifiers. Test light and dark themes, known variable types, neutral types, dialogue after branches merge, and coverage
contrast.

The native lexer is deliberately line-local. Do not introduce a narrative quote region that swallows commands or
reimplement the shared analyzer's branch logic in Kotlin.

## Runtime cache

Verify bundled archives before extraction and namespace the cache by manifest and layout version. Extract only the host
native target. Place its executable beside Node as `runtime/lsp.exe` or `runtime/lsp`, with the original license and
manifest retained. This avoids duplicating host binaries and keeps its launch path no longer than Node's; Windows can
reject an executable beyond 260 characters even when Java NIO can read it. Restore executable permissions on Unix.

## Kotlin and platform interop

The build uses `JvmDefaultMode.NO_COMPATIBILITY` so platform interface defaults supply unimplemented `ToolWindowFactory`
methods directly. Older platforms needing compatibility bridges are outside the current baseline.

With Kotlin 2.2.20 and the declared 2026.1.4 APIs, `ContentManager.setSelectedContent` and
`EditorColorsManager.setGlobalScheme` remain method calls; apparent property assignments do not compile. Keep relevant
`UsePropertyAccessSyntax` suppressions local and revisit them when upgrading the compiler or platform.

Use idiomatic multiline Kotlin. API-status warnings must be assessed against exact symbols and verifier results rather
than suppressed across a file. See [compatibility](jetbrains-compatibility.md#experimental-apis-and-warnings).

## Review checklist

A transport/UI change should cover native project discovery, standard LSP features, custom events, cancellation,
current/stale coverage, trust behavior, preview fallback, and project close. Run the focused native tests and Plugin
Verifier, then record remaining manual/platform gaps honestly. Do not present the direct integration harness as
end-to-end proof of all these behaviors.
