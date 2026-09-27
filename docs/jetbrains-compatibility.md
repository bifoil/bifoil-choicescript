# JetBrains compatibility matrix

The CI matrix runs native tests, packaged Node/LSP launch, project detection, completion, rename, trust refusal, semantic parity and Plugin Verifier for each declared product. Passing results, not this configuration alone, establish validation; see [validation.md](validation.md).

| Product | Minimum tested version | Exact build |
| --- | --- | --- |
| IntelliJ IDEA | 2026.1.4 | 261.26222.65 |
| WebStorm | 2026.1.4 | 261.26222.58 |
| PyCharm | 2026.1.4 | 261.26222.68 |

Versions/builds were checked against the [official product releases API](https://data.services.jetbrains.com/products/releases?code=IIU,WS,PCP&latest=false&type=release). The descriptor uses the shared platform baseline `261.26222`, because product-specific suffixes differ. IDEA's baseline remains 2026.1.4. The required native LSP module excludes incompatible products; older Community editions and Android Studio are outside support. Other products and newer builds remain unverified until their own checks pass.

Run a product locally with `bash editors/intellij/gradlew -p editors/intellij -PplatformProduct=webstorm test buildPlugin verifyPlugin`; `idea` is the default, and `pycharm` is also accepted. The distribution built against IDEA is the release artifact; the other builds validate the same adapter source against their SDKs.

The integration follows [JetBrains native LSP support](https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html), which is experimental. Experimental API warnings remain visible in verifier reports. Compatibility cannot be assumed across future platform versions.
