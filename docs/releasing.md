# Packaging and releases

This guide is for maintainers building installers. For installing an existing build, see [installation](support.md). Run commands from a fresh repository checkout with its pinned engine submodule and [development dependencies](../CONTRIBUTING.md#build-from-source).

## Build a package

Packaging consumes the shared build output; build and check it first:

```sh
pnpm install --frozen-lockfile
pnpm check
```

### VS Code

Build for the current host:

```sh
pnpm package:vscode
```

Or select a target explicitly:

```sh
pnpm package:vscode linux-arm64
```

Targets are `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64`. Installers go to `dist/packages/bifoil-choicescript-<target>.vsix`. Each contains the target's Node runtime, server, engine, and notices. Cross-packaging an installer is not a substitute for testing it on its target host.

### JetBrains

Prepare all six runtimes, then build and verify the distribution:

```sh
pnpm package:intellij
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

Use `editors\intellij\gradlew.bat` on Windows without Bash. The IDEA-built ZIP under `editors/intellij/build/distributions/` is the distribution artifact. The other declared products also require [compatibility checks](jetbrains-compatibility.md).

`pnpm package:intellij` prepares resources; it does not run Gradle or create the installable plugin ZIP. `--current` prepares only the host runtime for development and must not be used for a universal release. `--server-only` refreshes an already prepared bundle's server resources without provisioning runtimes again.

### All targets

`pnpm package:all` builds the shared code, creates all six VSIX packages, and prepares the universal IntelliJ resource bundle. You must still run Gradle to create and verify the JetBrains ZIP. It is an artifact-building convenience, not the complete release acceptance gate.

## Provenance and licenses

Before packaging, engine revision and file hashes must match `vendor/choicescript.lock.json` and `vendor/checksums.json`. Runtime downloads are checked against `runtime-lock.json`; packaged runtime metadata records archive and binary hashes. JavaScript dependency versions are locked in `pnpm-lock.yaml`.

Preserve the engine license, Node license, and dependency notices in each distribution. The Linux Gradle dependency inventory in `docs/provenance/gradle-linux-x64.xml` is supplementary provenance, not a portable enforcement lock. See [third-party notices](../THIRD_PARTY_NOTICES.md).

## Publish a private prerelease

The [Private prerelease workflow](../.github/workflows/release.yml) is manually dispatched with a new prerelease tag such as `v0.1.0-alpha.1`. It rejects a public repository or a tag without a prerelease suffix.

Before dispatching it:

1. Choose the intended source revision and check that package/plugin versions and [release notes](release-notes.md) describe it.
2. Complete the relevant [manual acceptance checks](testing.md#manual-acceptance), or explicitly retain outstanding limitations in the prerelease notes.
3. Review the engine/runtime pins and third-party notices.

The workflow calls **Build and verify**. All six VS Code platform jobs and all three JetBrains product jobs must pass before publication. It collects six VSIX files and the IDEA-built universal ZIP, then creates:

- `release-manifest.json`, with the source commit, version, target platforms, artifact sizes and hashes, and validation run.
- `SHA256SUMS.txt`, covering the packages and accompanying release files.
- Release notes, license notices, engine/runtime pins, and dependency provenance.

The workflow creates the private prerelease, downloads its assets again, and verifies them. A failure after creation can leave a release present; inspect its assets and workflow result before retrying. A successful build alone does not mean a prerelease was published.

To recheck a downloaded release directory locally, with repository dependencies installed:

```sh
node scripts/verify-release.mjs "/path/to/downloaded-release"
```

Marketplace publication is outside the first release. Runtime binaries and generated installers belong in build/release artifacts, not Git history.
