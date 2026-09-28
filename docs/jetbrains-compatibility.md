# JetBrains compatibility

Branchlight uses JetBrains' built-in LSP integration. These are the declared product baselines used by the build and compatibility checks:

| Product       | Version  | Build          | Gradle selector |
| ------------- | -------- | -------------- | --------------- |
| IntelliJ IDEA | 2026.1.4 | `261.26222.65` | `idea`          |
| WebStorm      | 2026.1.4 | `261.26222.58` | `webstorm`      |
| PyCharm       | 2026.1.4 | `261.26222.68` | `pycharm`       |

The descriptor uses `sinceBuild = 261.26222` because the products have different build suffixes. Its required `com.intellij.modules.lsp` dependency excludes IDEs without the native LSP module. Older Community editions and Android Studio are outside support.

A minimum build in the descriptor is not a promise that every newer product build has been tested. Other products and later platform versions require their own verification. The build numbers can be checked against JetBrains' [product releases API](https://data.services.jetbrains.com/products/releases?code=IIU,WS,PCP&latest=false&type=release).

## Distribution and checks

The IDEA-built ZIP is the distribution artifact. WebStorm and PyCharm builds validate the same adapter source against their SDKs; they are not separate product variants to install.

After preparing the shared server and runtime bundle, select a product explicitly:

```sh
bash editors/intellij/gradlew -p editors/intellij -PplatformProduct=webstorm test buildPlugin verifyPlugin
```

Replace `webstorm` with `idea` or `pycharm` as needed. See [testing](testing.md#jetbrains-checks) for preparation and Windows commands.

## Platform upgrades

[JetBrains' native LSP API](https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html) is experimental. Experimental API warnings can therefore appear in verifier reports for the adapter. Inspect the full compatibility result instead of assuming any warning is either harmless or a failed verification.

When changing the platform baseline, update the Gradle dependencies and plugin descriptor together, run native tests and Plugin Verifier for every declared product, and manually check semantic colors, navigation, project selection, and preview. Update this matrix and the installation guide with the builds actually verified. See [API maintenance](jetbrains-api-notes.md) for implementation constraints.
