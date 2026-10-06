# Third-party notices

Bifoil ChoiceScript is an unofficial Bifoil Foundation project maintained by Chinay, unaffiliated with Choice of Games
or upstream ChoiceScript.
Original Bifoil ChoiceScript code is covered by the MIT license in `LICENSE`. Dependencies and upstream template
material retain
the licenses below; bundling them does not imply endorsement or change their terms.

## ChoiceScript

- Upstream: [dfabulich/choicescript](https://github.com/dfabulich/choicescript).
- Pinned revision: `60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a`.
- License: ChoiceScript License 1.0, preserved as `vendor/choicescript/LICENSE.txt` in source and with the bundled
  engine in distributions.

The engine is an unmodified Git submodule at `vendor/choicescript`. Original source comments and notices are retained.
`vendor/choicescript.lock.json` records the repository, revision, and original archive provenance;
`vendor/checksums.json` records per-file hashes checked by the build. `vendor/runtime-files.json` selects the original
runtime, official test runners, template, and license files shipped in plugins and staged games; upstream development
files remain in the source submodule.

New games use the pinned upstream template and include `CHOICESCRIPT-LICENSE.txt` and `UPSTREAM-TEMPLATE.md`.
Bifoil ChoiceScript's MIT license does not replace the license for that material.

## Node.js

Runtime archives come from the [official Node.js distribution service](https://nodejs.org/dist/). `runtime-lock.json`
records the exact version, archive names, and SHA-256 hashes for each supported target.

Each packaged runtime includes `NODE-LICENSE` and `provenance.json`, which identifies its source archive and records
archive and executable hashes. Node.js and its bundled components retain their upstream license notices.

## JavaScript dependencies

`pnpm-lock.yaml` records resolved dependency versions and integrity information. Packaging collects dependency licenses
and includes them with the server distribution. Each library remains subject to its own license.

Development VSIX packaging uses Microsoft's `@vscode/vsce` 4.0.0, with `tinyglobby` and `picomatch` for file discovery
and the Secretlint core/rules for secret detection. The legacy `braces` dependency chain has been removed; no local
dependency patch is required.

## JetBrains and JVM build dependencies

The JetBrains platform, Kotlin, Gradle, Plugin Verifier, and other JVM dependencies are obtained through their
respective distributions and repositories. The plugin does not bundle an IDE or JetBrains Runtime.

`docs/provenance/gradle-linux-x64.xml` records resolved Gradle/JVM dependency versions and SHA-256 values from a Linux
verification build. It is a dependency inventory, not a cross-platform enforcement lock: IDE metadata and platform
archives can vary by host. Gradle wrapper and plugin versions are declared in the Gradle project files.
