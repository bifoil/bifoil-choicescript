# Packaging and releases

This guide is for maintainers. For installation, see [support](support.md). Building an artifact, validating it, and
publishing it are separate operations. The repository is a private prerelease; ordinary development work does not
authorize publication or changing visibility.

## Prepare the source

Use the declared [development toolchain](development.md). Check the intended source revision and working tree before
building, initialize the pinned submodule, then run:

```sh
git -c core.autocrlf=false submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm check
```

Preserve upstream line endings. Do not package around an unexplained engine checksum mismatch. Package scripts consume
the shared build outputs, so rebuild after source edits.

## VS Code packages

Build for the current host:

```sh
pnpm package:vscode
```

Or select a target:

```sh
pnpm package:vscode linux-arm64
```

| Target         | Host                |
| -------------- | ------------------- |
| `win32-x64`    | Windows x64         |
| `win32-arm64`  | Windows ARM64       |
| `darwin-x64`   | macOS Intel         |
| `darwin-arm64` | macOS Apple silicon |
| `linux-x64`    | glibc Linux x64     |
| `linux-arm64`  | glibc Linux ARM64   |

Output is `dist/packages/bifoil-choicescript-<target>.vsix`. Each package includes its Node runtime, language server,
worker, selected engine files, notices, and the extension. The build generates the distribution README from the root
README.

Cross-packaging does not validate execution on another host. Use
[extracted-package and editor tests](testing.md#packaged-vs-code-checks) on the matching host. Do not run parallel
package commands that mutate the same adapter runtime directory.

## JetBrains package

Prepare the universal resource bundle:

```sh
pnpm package:intellij
bash editors/intellij/gradlew -p editors/intellij test buildPlugin verifyPlugin
```

On Windows without Bash:

```powershell
pnpm package:intellij
editors/intellij/gradlew.bat -p editors/intellij test buildPlugin verifyPlugin
```

`pnpm package:intellij` prepares server/runtime archives and a manifest under
`editors/intellij/src/main/resources/bundle`. It does **not** run Gradle or produce the installable ZIP. Gradle writes
the plugin ZIP under `editors/intellij/build/distributions`.

| Preparation option | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| No option          | Prepare all six runtimes for a universal distribution               |
| `--current`        | Prepare only the host runtime for local development                 |
| `--server-only`    | Refresh server resources using an already prepared runtime manifest |

A `--current` ZIP is not universal. `--server-only` cannot turn a host-only manifest into a universal one. Use the
IDEA-built ZIP as the distribution artifact and validate the same adapter source with `-PplatformProduct=webstorm` and
`-PplatformProduct=pycharm` too. See [compatibility](jetbrains-compatibility.md).

## All-target preparation

`pnpm package:all` builds shared code, creates all six VSIX files, and prepares the universal IntelliJ resource bundle.
Gradle is still required to build/verify the JetBrains ZIP. This command may download substantial runtime data; prefer
host-only work while iterating.

`pnpm runtime <target>` provisions an individual runtime. `pnpm runtime --all` provisions every locked target. Archives
are cached and verified before use. Changing the runtime pin requires matching archive hashes and provenance, not just
editing a version label.

## Provenance and package contents

| Source of truth                                     | Records                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| [Engine lock](../vendor/choicescript.lock.json)     | Upstream URL, exact submodule commit, archive provenance |
| [Engine checksums](../vendor/checksums.json)        | Per-file expected hashes                                 |
| [Runtime inventory](../vendor/runtime-files.json)   | Unmodified engine files selected for shipping            |
| [Node lock](../runtime-lock.json)                   | Exact Node archive names and SHA-256 values              |
| [pnpm lock](../pnpm-lock.yaml)                      | JavaScript dependency versions/integrity                 |
| [Gradle inventory](provenance/gradle-linux-x64.xml) | One environment's resolved JVM dependencies and hashes   |

The Gradle inventory is supplementary provenance, not a portable enforcement lock. Each packaged Node runtime includes
`NODE-LICENSE` and `provenance.json` with archive/executable hashes. Retain the engine license and dependency notices.
Source maps and unselected upstream development files are not part of the intended server distribution.

Inspect actual archive contents when validating a packaging change. A provenance file's presence alone does not prove
that the listed binaries match those running.

## Candidate gates

Before calling an artifact validated:

1. Record the exact source revision, dependency pins, package target, and hash.
2. Run relevant source tests, extracted-bundle tests, native adapter tests, and Plugin Verifier.
3. Exercise installed-plugin behavior in the declared editors, including the minimum VS Code version.
4. Check manual light/dark presentation, project detection, both dialogue outcomes, tools, cancellation, assets, and
   cleanup.
5. Measure useful native-editor latency and combined runtime RSS on required large-game workloads.
6. Record all failures/unverified dimensions in candidate notes.

Current [known limitations](known-limitations.md) remain release-acceptance gaps. Do not erase them because an installer
build or static review passed. Marketplace publication is outside the first release.

## Private prerelease workflow

The [Private prerelease workflow](../.github/workflows/release.yml) is manually dispatched with a prerelease tag such as
`v0.1.0-alpha.1`. It checks that the repository is private and the tag matches its prerelease naming pattern.

**It does not check that the tag is unused.** Before dispatch, verify that the intended tag is absent or explicitly
resolve its existing target. An existing tag can point to a different commit from the newly built assets despite
`--target` being passed to release creation. Do not publish mismatched tag, manifest, and package revisions.

Also check that package/plugin versions and [candidate notes](release-notes.md) describe the intended revision and its
remaining limitations. Creating a tag/release requires explicit maintainer authorization.

The workflow calls [Build and verify](../.github/workflows/ci.yml) with `build_packages: true`; all six VS Code platform
jobs and three JetBrains product jobs must pass before its publication job proceeds. Ordinary pushes and pull requests
run source and native tests without producing installers. For package validation without publication, manually dispatch
Build and verify with `build_packages` enabled.

The prerelease workflow collects six VSIX files and the IDEA-built ZIP, then creates:

- `release-manifest.json` with revision, version, targets, artifact sizes/hashes, and validation run.
- `SHA256SUMS.txt` covering the release contents.
- Release notes, license notices, engine/runtime pins, and dependency provenance.

It creates the private prerelease, downloads assets again, compares checksums, and verifies the downloaded manifest. A
late failure can leave a partially created release. Inspect the remote release and workflow before retrying; do not
silently overwrite, retag, or delete a published release.

To validate a downloaded release directory locally:

```sh
node scripts/verify-release.mjs downloaded
```

This checks the release files against their recorded inventory; it is not a substitute for native execution or trusting
the source of the manifest.

## Storage and retention

Installers uploaded by optional packaging runs expire after one day. The release workflow downloads them during the
same run; assets attached to a completed GitHub Release have their own lifecycle. Only the IDEA-built JetBrains ZIP is
uploaded, since it is the distribution artifact. WebStorm and PyCharm still receive package verification. Diagnostics
are uploaded only after a job fails and expire after seven days.

Retention changes apply to new uploads; existing artifacts retain their previous expiry dates. Routine successful
pushes and pull requests upload no artifacts. Keep installers and runtime binaries out of Git history. Reuse runtime/SDK
caches. Remove only obsolete, task-owned extraction/report directories after their processes exit. Keep the minimal
evidence needed to identify and reproduce a failed candidate.

## Developer artifact paths

The release assembly/verifier and VSIX extractor accept paths beneath this checkout's `release/`, `downloaded/`,
`dist/` or ignored development-output directories. Copy downloaded packages into one of those areas before verification.
The synthetic benchmark's report stays under the ignored development-output directory. These scripts reject traversal,
existing symlink ancestors and filenames that have ambiguous meanings across Windows and Unix. They do not restrict the
game-project or export paths selected through the editor.
