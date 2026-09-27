# IntelliJ API maintenance

Verified against IntelliJ IDEA 2026.1.4, build 261.26222.65, with Plugin Verifier 1.410 on 2026-09-27. Native theme tests cover both light/dark schemes and combined bold/italic styles.

The game picker now uses `ChooseElementsDialog` in single-selection mode instead of deprecated `Messages.showChooseDialog`. Semantic styles create keys with a fallback key and assign derived attributes through the active editor scheme, avoiding the deprecated text-attributes constructor overload. The base colors still follow the user's scheme.

Kotlin's `JvmDefaultMode.NO_COMPATIBILITY` uses JVM interface defaults directly. This removes synthetic `ChoiceToolWindow` bridges for `isApplicable`, `isDoNotActivateOnStart`, `getAnchor`, `getIcon` and `manage`; the plugin does not implement or call those methods. Platform defaults remain in effect. This plugin does not support older platforms requiring those compatibility bridges.

After these changes Plugin Verifier reports Compatible with no deprecated or experimental usages in the plugin bytecode on the baseline. The native LSP integration is still an experimental JetBrains API by contract, even when a particular verifier report contains no experimental-usage warnings. Keep compatibility verification mandatory for each advertised product/build; do not suppress future warnings or incompatibilities.
