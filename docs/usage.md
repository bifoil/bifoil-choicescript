# Write and test a game

This guide assumes you have [installed Bifoil ChoiceScript](support.md) and opened a game folder. In VS Code, find actions in the Command Palette under **Bifoil ChoiceScript**. In JetBrains IDEs, use **Tools → Bifoil ChoiceScript**.

## Edit scenes

Bifoil ChoiceScript supplies completion, hover documentation, go to definition, find references, rename, document and workspace symbols, folding, and selection ranges through your editor's usual actions. Rename updates resolved code references; it does not rewrite prose or guess the destination of an unresolved indirect reference.

Use the editor's completion action when you need suggestions. VS Code disables automatic quick suggestions for ChoiceScript by default to avoid interrupting prose. Snippets and JetBrains live templates provide common command structures; normal Enter and comment actions handle indentation and `*comment` lines.

| Action                        | Result                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| **Bold Selection**            | Wraps selected text in `[b]…[/b]`                            |
| **Italicize Selection**       | Wraps selected text in `[i]…[/i]`                            |
| **Show Narrative Word Count** | Reports the current scene's narrative word count             |
| **About**                     | Shows the plugin version and independent project information |

Command strings and narrative dialogue have separate highlighting rules. Dialogue may span branches and scenes; an unfinished string in a command produces a local syntax diagnostic. See [language behavior](specification.md) and [color settings](configuration.md#colors-and-semantic-highlighting).

## Preview

1. Open a scene from the game you want to run.
2. Choose **Run Game**. If the active file does not identify a game and several are available, choose one from the picker.
3. Play in the preview panel, or use **Open in browser** / **Open in Browser** to open the same preview in your browser. JetBrains uses the browser automatically when JCEF is unavailable.
4. After an edit, run **Run Game** again to restart with the new source. Preview does not reload while you type.
5. Use **Stop Game or Tests** when finished. Closing an embedded preview also stops its preview job.

Each run uses a staged copy of the game, with open scene buffers overlaid on the files on disk. Unsaved scene edits are included. Editing afterward marks the result stale and changes the preview title; the running game continues to use its existing snapshot until restarted.

Preview uses a local loopback server. A browser tab depends on that server: stopping the job ends access to the preview. In remote development, use your editor's port forwarding if the browser cannot reach the extension host's loopback address.

## QuickTest and RandomTest

Use **Run QuickTest** to invoke the bundled engine's official QuickTest runner. Use **Run RandomTest** to exercise randomized playthroughs; enter an iteration count and seed when prompted.

The default is **1,000 iterations with seed 0**. You can set project defaults in [choicescript.json](configuration.md#randomtest-defaults). Use the same source snapshot, engine, seed, and iteration count to reproduce a run. Iterations must be between 1 and 10,000,000. For seeds shared between both editor dialogs, use a signed 32-bit integer.

Output appears in the **Bifoil ChoiceScript** output channel in VS Code or the **Bifoil ChoiceScript** tool window in JetBrains. Reported scene failures include source locations. Full output is saved to `.bifoil-choicescript/logs/<job-id>.log` under the game root; the completion message gives the log path.

Cancel through the progress UI or **Stop Game or Tests**. Edits make prior results stale, so rerun against the new snapshot before relying on the result.

### Coverage

RandomTest requests coverage from the official runner. When that runner reports coverage, VS Code decorates covered lines in visible scene editors, while JetBrains prints a per-scene covered-line summary in the console. The two adapters share the coverage data but present it differently. VS Code clears visible coverage decorations when results become stale.

Coverage describes the paths exercised by that run. Increasing iterations may explore more paths; it does not establish that every possible playthrough is correct.

## Export HTML

Choose **Export HTML** and select a new output file, preferably in an empty destination directory. Bifoil ChoiceScript invokes the official compiler and copies companion assets next to the generated HTML. Keep those files together when moving or serving the exported game.

Export includes the staged scene snapshot, including open buffers. Existing destination files are not overwritten. A collision can leave a partially copied export, so retry in a fresh directory after checking the reported failure. Avoid exporting back into your source or asset directory.

The generated game and upstream template retain their applicable licenses; see [third-party notices](../THIRD_PARTY_NOTICES.md).

## Trust and cleanup

Game operations, including project creation, require the editor's workspace/project trust. Language analysis remains available in an untrusted workspace. Stopping a job or shutting down the language server cleans up its owned child process and staging directory; saved logs remain available in the game folder.

If a game operation fails, use its output to diagnose the problem while continuing to edit. See [troubleshooting](troubleshooting.md) for common failures.
