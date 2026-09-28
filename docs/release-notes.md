# Branchlight 0.1.0 private prerelease

Independent ChoiceScript tooling for VS Code and JetBrains IDEs, unaffiliated with Choice of Games or upstream
ChoiceScript.

This candidate includes shared dialogue and type analysis, LSP authoring features, project templates, snapshot preview,
official QuickTest and seeded RandomTest, available coverage, cancellable jobs and HTML export. It bundles Node 24.21.0
and the unchanged ChoiceScript engine at `60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a`.

Six VSIX files cover Windows, macOS and Linux on x64/ARM64. The universal JetBrains ZIP includes all six runtimes.
Install the appropriate VSIX through Extensions: Install from VSIX, or the ZIP through Settings → Plugins → Install
Plugin from Disk. System Node is not required.

Every release workflow builds from clean checkouts and must pass six packaged-runtime/editor jobs and native tests plus
Plugin Verifier on IDEA, WebStorm and PyCharm 2026.1.4. The manifest identifies the exact source commit and artifact
hashes. Uploaded assets are downloaded again and checked against SHA256SUMS.txt.

This is a private prerelease. Theme readability, embedded preview and browser fallback, and interactive
failure-link/progress presentation have not yet completed manual acceptance testing. Marketplace publication is
excluded.

Runtime binaries are packaged artifacts, never committed to the source repository. Licenses, dependency locks and
notices accompany the release and are also included in the installers.
