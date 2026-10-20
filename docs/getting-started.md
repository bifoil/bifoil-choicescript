# Your first game

This walkthrough creates an original, small ChoiceScript game using the bundled upstream template. It covers both
editors; the same shared engine and language service power each adapter. First [install the plugin](support.md).

## 1. Create or open a project

In VS Code, open the Command Palette and choose **Bifoil ChoiceScript: New Project**. In JetBrains, choose **Tools →
Bifoil ChoiceScript → New Project**. Choose a new directory or an empty directory; project creation refuses to merge a
template into an existing collection of files.

The template comes from the bundled pinned engine. Keep its runtime assets, `CHOICESCRIPT-LICENSE.txt`, and
`UPSTREAM-TEMPLATE.md`. Creating a project does not grant new rights to upstream material.

The files you will edit are:

```text
my-first-game/
├── choicescript.json
├── scenes/
│   ├── startup.txt
│   └── choicescript_stats.txt
├── CHOICESCRIPT-LICENSE.txt
└── UPSTREAM-TEMPLATE.md
```

The generated template also contains other game assets and sample scenes. The tree above shows the relevant subset, not
a complete generated-file list. Existing sample scenes need not be added to your new story's `*scene_list`.

Alternatively, open an existing game containing `scenes/startup.txt`. No extension-specific project file is required for
this conventional layout.

## 2. Write the story

Replace `scenes/startup.txt` with:

```choicescript
*title The Lantern Path
*author Example Author
*create name "traveler"
*create courage 50
*create took_bridge false
*create implicit_control_flow true
*scene_list
  startup

You reach a river at dusk.

The keeper says "The path ahead is
*if courage > 40
  yours to choose."
*else
  waiting for you."
The lantern flickers.

*choice
  #Cross the bridge.
    *set took_bridge true
    *set courage %+ 10
    *goto arrival
  #Follow the riverbank.
    *set courage %- 10
    *goto arrival

*label arrival
Welcome, ${name}. You @{took_bridge crossed the bridge|followed the riverbank}.
Your courage is ${courage}.
*ending
```

Replace `scenes/choicescript_stats.txt` with:

```choicescript
*stat_chart
  percent courage Courage
  text name Name
```

Save both files. Directives start with `*`, options with `#`, and indentation defines blocks. There are no colons after
`*if` or `*else`. `implicit_control_flow` permits the conditional alternatives to continue into the following narrative;
the choice options use explicit jumps.

The two conditional lines close the same quote from the keeper's dialogue on separate paths. The following sentence
should return to ordinary narrative styling. A command's string value, such as `"traveler"`, is separate from narrative
dialogue.

## 3. Try the editor features

- Hover over `*choice` or `*set` to read command help.
- Request completion after `*` on a new line, or after `*goto ` for local labels.
- Navigate from `*goto arrival` to `*label arrival`.
- Find references to `courage` from its declaration.
- Inspect string, number, and boolean variable colors for `name`, `courage`, and `took_bridge`.
- Select prose and invoke **Bold Selection** or **Italicize Selection** to insert `[b]…[/b]` or `[i]…[/i]`.
- Invoke **Show Narrative Word Count** for the current scene.

Theme colors differ between editors. The classification is shared; a particular RGB color is not required. Rename is
implemented, but review every proposed edit because the prerelease has
[known edge cases](known-limitations.md#language-analysis-and-rename).

As a recovery exercise, temporarily delete the final quote in `*create name "traveler"`. The editor should report
`expression-string` on that line. Later commands should remain commands. Restore the quote before testing the game.

## 4. Run the official tests

Trust the project through your editor's normal trust UI if you intend to execute it. Invoke **Run QuickTest**. Inspect
the Bifoil ChoiceScript output/tool window and the Problems view.

Then invoke **Run RandomTest**, set **iterations to 20** and **seed to 0**, and run it. Record those values when
reporting a failure. RandomTest explores sampled playthroughs; passing does not establish that every possible story path
works.

Available line coverage can help locate unvisited passages. Coverage is currently unreliable in JetBrains because of a
notification integration defect; absent decorations are not proof that no lines ran. The
[game-tools guide](game-tools.md) explains coverage and stale results.

## 5. Play both choices

Invoke **Run Game**. Choose each route in separate playthroughs and check the ending text and courage value. To check
both keeper-dialogue alternatives, change the initial courage to `30`, invoke **Run Game** again, and then restore `50`.

Preview uses a staged snapshot. Editing a scene does not hot-reload a running game. Restart with **Run Game** to capture
new buffers, and use **Stop Game or Tests** when finished. Reusing the old browser page after stopping is not a test of
a new server or new source.

## 6. Export

Invoke **Export HTML** and select a new output location, such as `export/lantern.html`. Keep any companion files next to
the HTML in their exported relative paths. Existing files are preserved; choose a fresh destination if an earlier export
would collide.

Open the exported game and check its text and assets. Export is not necessarily a single self-contained file, and the
current compiler packaging has a [font-asset limitation](known-limitations.md#game-tools). Distributing the result still
requires following the licenses for the engine and any game assets.

## Next steps

Use [projects](projects.md) to add more scenes or adopt an engine checkout, [authoring](usage.md) for editing workflows,
and [configuration](configuration.md) for test defaults and colors. For the distinction between dialogue warnings and
ChoiceScript syntax errors, read [diagnostics](diagnostics.md).
