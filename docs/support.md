# Install Branchlight

Packaged plugins include their own Node.js runtime and ChoiceScript engine. You need a supported editor, not a system Node.js installation. Building from source has separate [development requirements](../CONTRIBUTING.md#build-from-source).

## Choose a build

Branchlight is in private prerelease development and is not on an editor marketplace. With repository access, download an installer from a successful **Build and verify** run in [GitHub Actions](https://github.com/Chinay-Domitrix/branchlight/actions/workflows/ci.yml). Unzip the downloaded Actions artifact to get the installer inside.

- For VS Code, choose the `vscode-…` artifact for your operating system and CPU. The installer filename identifies its target, as listed below.
- For JetBrains IDEs, choose `intellij-idea`. Its plugin ZIP is the distribution artifact; the WebStorm and PyCharm artifacts are compatibility builds of the same adapter.
- When a private prerelease is published, its installers and checksum file are also available under [Releases](https://github.com/Chinay-Domitrix/branchlight/releases).

| System           | x64 VS Code installer         | ARM64 VS Code installer         |
| ---------------- | ----------------------------- | ------------------------------- |
| Windows          | `branchlight-win32-x64.vsix`  | `branchlight-win32-arm64.vsix`  |
| macOS            | `branchlight-darwin-x64.vsix` | `branchlight-darwin-arm64.vsix` |
| Linux with glibc | `branchlight-linux-x64.vsix`  | `branchlight-linux-arm64.vsix`  |

The distribution JetBrains ZIP includes all six runtimes. Alpine Linux and other musl-based environments are outside the packaged runtime targets.

For a WSL or SSH workspace, use a VSIX matching the machine that runs the extension host. A Windows desktop connected to a Linux extension host needs the Linux build in that host.

## VS Code

Requires VS Code desktop **1.109 or later**.

1. Open the Command Palette and run **Extensions: Install from VSIX**.
2. Select the downloaded `.vsix` for your host and reload if prompted.
3. Open the folder containing your game and then a scene file.

The extension identifier is `chinay.branchlight`. Disable older development extensions for ChoiceScript if they provide duplicate diagnostics or language clients.

Browser-only VS Code and virtual workspaces are outside the first release.

## JetBrains IDEs

The declared product baselines are **IntelliJ IDEA, WebStorm, and PyCharm 2026.1.4**. Check the [exact compatibility matrix](jetbrains-compatibility.md) before installing in another build. Branchlight requires the IDE's built-in LSP module; older Community editions and Android Studio are outside support.

1. Open **Settings → Plugins**.
2. Use the gear menu's **Install Plugin from Disk** action and select the plugin ZIP inside the downloaded Actions artifact, or the ZIP from a release.
3. Restart if prompted and open your game folder.

The plugin identifier is `dev.chinay.branchlight`. Commands are under **Tools → Branchlight**, and run output appears in the **Branchlight** tool window.

## Open or create a game

These layouts are discovered automatically:

```text
my-game/
  scenes/
    startup.txt
    choicescript_stats.txt
    chapter-one.txt
```

Existing engine layouts such as `web/mygame/scenes/startup.txt` work too. A workspace may contain several games. Only text files inside detected scene directories receive automatic ChoiceScript association.

For another layout, add [choicescript.json](configuration.md#project-layout). For a standalone scene, explicitly select the ChoiceScript language/file type in your editor. Prefer explicit per-file selection over a global `*.txt` association.

To start a game, use **New Project**, choose a parent folder and a new folder name, then open the created folder. The command uses the bundled upstream template and preserves its license notices. The destination must be absent or empty.

Continue with the [user guide](usage.md) to preview, test, and export. If a scene stays plain text or the server does not start, see [troubleshooting](troubleshooting.md).
