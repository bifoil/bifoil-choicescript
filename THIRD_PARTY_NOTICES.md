# Third-party notices

Branchlight is an independent personal project. It is unaffiliated with Choice of Games or upstream ChoiceScript.

The original editor tooling uses the MIT license; see `LICENSE`.

- **ChoiceScript:** https://github.com/dfabulich/choicescript, commit `60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a`. The
  unmodified source is pinned as the `vendor/choicescript` Git submodule; its ChoiceScript License is in
  `vendor/choicescript/LICENSE.txt`. Its source comments and notices are retained. The submodule commit and original
  archive provenance are in `vendor/choicescript.lock.json`; per-file checksums are in `vendor/checksums.json`.
- **Node.js:** Node 24 LTS binary archives from https://nodejs.org/dist. Exact versions and SHA-256 checksums are in
  `runtime-lock.json`. Each packaged runtime includes `NODE-LICENSE` and `provenance.json`.
- **JavaScript libraries:** Dependency versions are locked in `pnpm-lock.yaml`. They retain their respective licenses.
  The packaging process includes dependency license notices.
- **JetBrains platform and build tools:** Used through their respective SDK and build-tool distributions. The plugin
  does not bundle a JetBrains IDE or JBR.

Bundling dependencies does not change their licenses or imply endorsement.

The resolved Gradle/JVM dependency versions and SHA-256 values from the Linux verification build are recorded in
`docs/provenance/gradle-linux-x64.xml`. This is an inventory, not a cross-platform Gradle enforcement file: local IDE
metadata and platform archives vary by build host. Node archives, the Gradle wrapper, the engine snapshot, and pnpm
packages retain their portable checksum locks.
