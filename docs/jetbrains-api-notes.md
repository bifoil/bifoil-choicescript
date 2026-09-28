# Maintain the JetBrains adapter

The Kotlin adapter owns editor integration and presentation. Shared language semantics remain in TypeScript and arrive through the native LSP client. Start with [architecture](architecture.md) and the [supported platform builds](jetbrains-compatibility.md).

## Native LSP and contracts

JetBrains' LSP integration is experimental. Run native integration tests and Plugin Verifier when updating the platform or changing integration points. Keep Kotlin DTOs aligned with [protocol version 1](protocol.md), including optional fields and zero-based source lines.

LSP4J invokes notification callbacks through reflection. Keep their `unused` suppressions scoped to the callback methods rather than hiding unused declarations across a file.

## UI and threading

The game picker uses `ChooseElementsDialog` with single selection. Action labels and live-template descriptions come from `messages.BranchlightBundle`.

The narrative-warning toggle declares EDT updates because it reads mutable settings also changed by UI actions. Console and preview changes are scheduled on the UI thread. Keep project state in project services and nonconstant parser state outside extension companion objects.

The tool window uses JCEF where supported and a browser fallback otherwise. Closing a preview must release its browser and stop the corresponding job. Project shutdown must also release owned resources.

## Colors

Semantic token keys inherit fallback attributes from the active editor scheme. Derived attributes preserve theme colors and bold/italic modifiers. Test both light and dark schemes when changing keys, fallbacks, or modifier handling; a correct token classification can still produce unreadable colors.

The native fallback lexer is line-local. Keep branch and cross-line dialogue analysis in the shared service rather than adding stateful narrative quote regions to the adapter.

## Kotlin and platform interop

The build uses `JvmDefaultMode.NO_COMPATIBILITY`, allowing platform interface defaults to supply unimplemented `ToolWindowFactory` methods directly. Older platforms requiring Kotlin compatibility bridges are outside the current baseline.

With Kotlin 2.2.20 and the 2026.1.4 APIs, `ContentManager.setSelectedContent` and `EditorColorsManager.setGlobalScheme` remain method calls: their apparent property assignments do not compile. The `UsePropertyAccessSyntax` suppressions are intentionally local to those calls or their test method. Revisit them when upgrading the compiler/platform combination, rather than expanding the suppression scope.
