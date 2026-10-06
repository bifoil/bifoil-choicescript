# JetBrains compatibility

Bifoil ChoiceScript uses JetBrains' built-in LSP integration. The declared baselines are:

| Product       | Version  | Build          | Gradle selector |
| ------------- | -------- | -------------- | --------------- |
| IntelliJ IDEA | 2026.1.4 | `261.26222.65` | `idea`          |
| WebStorm      | 2026.1.4 | `261.26222.58` | `webstorm`      |
| PyCharm       | 2026.1.4 | `261.26222.68` | `pycharm`       |

The descriptor uses `sinceBuild = 261.26222` because product suffixes differ.
The required `com.intellij.modules.lsp` module excludes IDEs without native LSP support.
Older Community editions and Android Studio are outside the first release.

These are build/verification targets, not a claim that every current candidate passed all native and manual acceptance
checks. A minimum descriptor build is not a guarantee that every later IDE build is compatible.

## Installation and runtime

Install the plugin ZIP through **Settings → Plugins → Install Plugin from Disk…**.
The IDEA-built ZIP is the distribution artifact; WebStorm/PyCharm builds validate the same source against their APIs,
not distinct product editions that users must choose among.

A universal ZIP contains Node runtimes for all six supported OS/architecture pairs.
A development ZIP prepared with `--current` contains only the builder's host runtime.
The adapter verifies and extracts its bundled resources into the IDE cache.

The IDE supplies its Java runtime. Contributors need JDK 21 to build the plugin;
users do not need to install it separately.
JCEF supplies embedded preview where the IDE supports it; otherwise the plugin provides a browser fallback.

## Run compatibility checks

From a prepared checkout:

```sh
pnpm build
pnpm package:intellij --current
bash editors/intellij/gradlew -p editors/intellij -PplatformProduct=webstorm test buildPlugin verifyPlugin
```

Use `idea` or `pycharm` as appropriate. On Windows replace the Bash wrapper invocation with
`editors/intellij/gradlew.bat`.
For universal release preparation omit `--current`.

Native tests exercise selected adapter behavior. Plugin Verifier checks platform API compatibility.
Neither alone proves normal LSP-manager startup, custom notification delivery, actual coverage rendering, or preview UI.
Those require the [native/manual checks](testing.md#manual-acceptance).

## Experimental APIs and warnings

The platform LSP API is experimental. Some API status warnings are therefore expected when using it.
Inspect their exact symbols and the verifier's final result; do not blanket-suppress warnings or interpret every warning
as a failed build.

Distinguish Gradle deprecation warnings, Kotlin compiler warnings, Plugin Verifier API warnings, and runtime IDE log
exceptions. They originate in different components and require different fixes.
Use Gradle `--warning-mode all` to expand Gradle deprecation details when investigating a build.

The current [JetBrains coverage defect](known-limitations.md#editor-integration) is a runtime transport issue, not proof
that the package fails binary compatibility verification.

## Change the platform baseline

Update the Gradle SDK declarations and plugin descriptor together, then check each declared product.
Exercise actual native startup, project notifications, navigation, semantic colors, tool actions, cancellation,
preview/fallback, and disposal. Recheck light and dark schemes.

Record exact IDE builds and artifacts tested, update this matrix, and
review [implementation notes](jetbrains-api-notes.md).
Do not broaden declared support based only on a successful compilation against one SDK.
