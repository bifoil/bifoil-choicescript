# IntelliJ API maintenance

The adapter targets the platform baselines in [JetBrains compatibility](jetbrains-compatibility.md). Native LSP
integration is an experimental JetBrains API; run native tests and Plugin Verifier when changing platform dependencies.

The game picker uses `ChooseElementsDialog` in single-selection mode. Semantic styles create keys with a fallback key
and assign derived attributes through the active editor scheme, preserving theme colors and bold/italic modifiers.

Kotlin's `JvmDefaultMode.NO_COMPATIBILITY` uses JVM interface defaults directly. Platform defaults supply the
`ToolWindowFactory` methods that the plugin does not override. Older platforms requiring Kotlin compatibility bridges
are outside the supported baseline.

Action labels and live-template descriptions use `messages.BranchlightBundle`. The narrative-warning toggle declares EDT
updates because it reads settings shared with UI actions. Keep nonconstant parser state outside extension companion
objects.

The `ContentManager.setSelectedContent` and `EditorColorsManager.setGlobalScheme` calls must remain method calls with
the current Kotlin 2.2.20 and 2026.1.4 API combination; property assignments do not compile. Their
`UsePropertyAccessSyntax` suppressions are scoped to those calls or the relevant test method. LSP4J invokes the
notification callbacks through reflection, so the callbacks have method-scoped `unused` suppressions.
