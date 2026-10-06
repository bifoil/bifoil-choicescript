# Install Bifoil ChoiceScript

This guide installs an existing package. To build one, use [development](development.md) and
[packaging](releasing.md). To start a game afterward, follow the [walkthrough](getting-started.md).

## Choose a build

Bifoil ChoiceScript is a private prerelease, not a marketplace extension. With repository access, obtain a candidate
from the repository's release assets or a successful Actions run. An Actions artifact may be a ZIP containing the
installer; extract that outer archive first.

Check the source revision and validation results attached to the candidate. A package's existence does not establish
that its platform passed testing. A local JetBrains build prepared with `--current` contains only its builder's runtime;
use a universal package for a different host.

| Host             | CPU              | VS Code target |
| ---------------- | ---------------- | -------------- |
| Windows          | Intel/AMD 64-bit | `win32-x64`    |
| Windows          | ARM64            | `win32-arm64`  |
| macOS            | Intel            | `darwin-x64`   |
| macOS            | Apple silicon    | `darwin-arm64` |
| Linux with glibc | Intel/AMD 64-bit | `linux-x64`    |
| Linux with glibc | ARM64            | `linux-arm64`  |

Choose the architecture of the environment running the extension. Remote extension hosts and mixed-architecture
emulation are not established acceptance configurations; do not infer their support from a successful local installation.
Musl-based Linux is not a declared runtime target.

Installers include the server, Node.js 24, the pinned ChoiceScript engine, and license notices. You do not need system
Node.js, pnpm, Git, or a separate engine checkout to use an installer. Building from source has different requirements.

## VS Code desktop

The declared minimum is VS Code **1.109**.

1. Download `bifoil-choicescript-<target>.vsix` for your host.
2. Open Extensions, choose its **…** menu, then **Install from VSIX…**.
3. Select the VSIX and reload if prompted.
4. Open your game folder, then `scenes/startup.txt`.
5. Check that the language mode is **ChoiceScript** and that the Command Palette contains **Bifoil ChoiceScript** actions.

The equivalent CLI form, if the `code` command is installed, is:

```sh
code --install-extension "/path/to/bifoil-choicescript-linux-x64.vsix"
```

Use your own package filename. A VSIX for another target can install incorrectly or fail when launching its runtime.

The extension activates on startup and for explicitly selected ChoiceScript files. Automatic detection only changes
plain-text scene files inside recognized games. It does not install a global `*.txt` association.
See [projects](projects.md) if a file remains plain text.

## IntelliJ IDEA, WebStorm, or PyCharm

The declared baseline is **2026.1.4**, with exact product builds in [compatibility](jetbrains-compatibility.md).
An older IDE with the same product name may lack the required built-in LSP APIs.

1. Open **Settings → Plugins**.
2. Open the gear menu and choose **Install Plugin from Disk…**.
3. Select the built plugin ZIP, not the repository source ZIP or the outer CI artifact archive.
4. Restart if requested.
5. Open the game as a project and open `startup.txt`.
6. Look for **Tools → Bifoil ChoiceScript** and the **Bifoil ChoiceScript** tool window.

Keep the ZIP intact when installing it. On first use the adapter extracts and verifies its bundled server/runtime into
the IDE's cache. The plugin uses the IDE's own Java runtime; it does not install an IDE or JDK.

JCEF provides the embedded game preview where available. A browser fallback is provided when it is unavailable.
Coverage display currently has a [known JetBrains delivery issue](known-limitations.md#editor-integration).

## Confirm the installation

Open a scene containing:

```choicescript
*create score 0
Your score is ${score}.
*finish
```

Hover over `*create` for command documentation and over `score` for symbol information. Navigate from the substitution
to its declaration. Basic fallback colors may appear before semantic analysis finishes.

Then use a complete game, such as the [walkthrough](getting-started.md), for **Run QuickTest** and **Run Game**.
These operations require editor workspace trust. Their failure does not by itself mean the language service failed.

## Update, disable, or uninstall

Install the replacement VSIX or plugin ZIP through the same UI, then reload/restart as prompted. Keep the editor
adapter and its bundled server together; copying a server from another candidate can break their shared protocol.

Disable/uninstall through the editor's extension/plugin manager. Game source files are not part of the installation and
should be retained. Saved game-tool logs under `.bifoil-choicescript/logs/` are project data and are not automatically
removed by uninstalling the plugin. Editor caches are editor-managed.

If replacing an older privately branded build, disable its old plugin entry so that two language services do not both
handle the same files. Retain game files and review any explicit language associations or color settings.

## What is not covered

Browser-only VS Code, Android Studio, older Community editions without the required LSP integration, debugging, and
marketplace publication are outside the first release. Later IDE versions need validation rather than an assumption of
compatibility. See [troubleshooting](troubleshooting.md) for launch failures
and [known limitations](known-limitations.md)
for current behavior that reinstalling will not fix.
