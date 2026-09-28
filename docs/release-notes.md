# Branchlight 0.1.0 prerelease

Branchlight brings ChoiceScript authoring tools to VS Code and JetBrains IDEs. It is an unofficial personal project by chinay, unaffiliated with Choice of Games or upstream ChoiceScript.

These notes describe the current prerelease candidate. The project is distributed privately and is not published to editor marketplaces.

## Included

- Shared dialogue analysis across branches, paragraphs, resolvable scene transitions, and subroutine calls, with separate expression-string recovery.
- Variable type highlighting, diagnostics, completion, hover, definitions, references, rename, symbols, folding, and selection ranges.
- Project discovery, upstream project templates, snippets, markup actions, and narrative word counts.
- Snapshot-based preview, official QuickTest and seeded RandomTest, available coverage, cancellable jobs, and HTML export with companion assets.
- Bundled Node.js 24.21.0 and the unmodified ChoiceScript engine at `60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a`.

## Installation and compatibility

VS Code desktop requires version 1.109 or later. The JetBrains baselines are IntelliJ IDEA, WebStorm, and PyCharm 2026.1.4, using their native LSP support. Six VSIX targets cover Windows, macOS, and glibc Linux on x64 and ARM64; the distribution JetBrains ZIP contains all six runtimes. System Node.js is not required.

See the [installation guide](https://github.com/Chinay-Domitrix/branchlight/blob/main/docs/support.md) and [JetBrains build matrix](https://github.com/Chinay-Domitrix/branchlight/blob/main/docs/jetbrains-compatibility.md). Repository access is required for downloads and documentation on GitHub.

## Known limitations

- This candidate has not completed manual acceptance for theme readability, embedded preview and browser fallback, and interactive failure-link/progress presentation.
- Dynamic destinations and generated text can leave dialogue or variable types uncertain; the analyzer uses neutral styling in those cases.
- Preview requires an explicit restart after edits. Coverage presentation differs between editors: visible-line decorations in VS Code and console summaries in JetBrains.
- Browser-only VS Code, older Community editions, Android Studio, debugging, and marketplace publication are outside the first release. Later JetBrains builds require additional verification.

## Verification and notices

The release workflow requires six packaged VS Code checks and native tests plus Plugin Verifier for all three declared JetBrains products. The release manifest identifies the source revision and artifact hashes; uploaded assets are downloaded and verified again. These automated gates do not replace the outstanding manual checks above.

Original Branchlight code is MIT licensed. Bundled dependencies, the ChoiceScript engine, and the upstream template retain their own licenses. Release files include the relevant licenses, notices, dependency pins, and checksums.
