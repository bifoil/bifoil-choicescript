# Projects and files

A Bifoil ChoiceScript project is a scene directory containing `startup.txt`, together with a game root and an asset
directory. Detection enables scene-file association, project-wide analysis, and game commands.
It does not require modifying an upstream engine checkout.

## Conventional layouts

A standalone game:

```text
game/
├── scenes/
│   ├── startup.txt
│   ├── chapter_one.txt
│   └── choicescript_stats.txt
└── images/
    └── lantern.png
```

Open `game/`. A directory named `scenes` uses its parent as both game root and default asset root.

An existing engine checkout:

```text
choicescript/
└── web/
    └── mygame/
        ├── scenes/
        │   ├── startup.txt
        │   └── choicescript_stats.txt
        └── images/
```

Open the checkout or `web/mygame/`. Tool runs still use the plugin's pinned bundled engine, not arbitrary engine source
from the opened checkout.

A flat source-only project:

```text
story/
├── startup.txt
├── choicescript_stats.txt
└── chapter_one.txt
```

Here `story/` is the scene directory, game root, and default asset root. Explicit configuration is useful if you later
separate scenes and assets.

Use lowercase `startup.txt` for portability. Unconfigured directory enumeration is tolerant of case, but configured
path checks and the runtime expect the conventional name.

## Explicit configuration

Place `choicescript.json` at the game root:

```json
{
  "scenes": "story/scenes",
  "assets": "game-assets",
  "randomtest": {
    "iterations": 1000,
    "seed": 0
  }
}
```

Both paths resolve relative to that file. They must be relative strings, not absolute paths. The implementation allows
parent-relative paths; keep sources inside the opened workspace where possible because external configured directories
have watcher limitations.

The scene directory must contain `startup.txt`. A valid config designates one game and stops discovery below that
root, even if its configured startup file is missing. A misspelled `scenes` path can therefore hide an otherwise
recognizable nested game. Invalid JSON or invalid option types produce configuration diagnostics.

See the [complete key reference](configuration.md#project-configuration).

## Multiple games

Open a parent folder containing one subdirectory per game, or use multiple VS Code workspace folders:

```text
stories/
├── river/
│   ├── choicescript.json
│   └── scenes/startup.txt
└── mountain/
    ├── choicescript.json
    └── scenes/startup.txt
```

Put configuration in each game's root. A single configuration at `stories/` claims that whole root as one project and
prevents recursive discovery of the others. If overlapping scene roots are present, association chooses the deepest
matching scene directory.

An active scene identifies the game for an action. Otherwise, the adapter can select the sole game or ask you to choose.
Avoid depending on simultaneous previews: the VS Code UI currently closes existing preview panels when starting another.

## Discovery boundaries

Discovery scans workspace roots through eight directory levels. It skips hidden directories and common generated or
dependency directories, including `.git`, `node_modules`, `vendor`, `dist`, `build`, `.cache`, `.idea`, and `.gradle`.
Ordinary directory symlinks are not recursively traversed. An explicitly configured root can resolve through a symlink;
that is different from following every symlink found during traversal.

If a game is deeper than the discovery limit, open its root directly or place configuration within the searchable
workspace. The scene enumerator considers `.txt` files beneath the selected scene directory.

**Runtime scene files must be flat.** The analyzer can encounter nested source files, but preview, tests, and export
reject nested scene layouts. Keep `chapter_one.txt` beside `startup.txt`; use asset subdirectories for images and audio.
Use distinct, portable scene names rather than relying on case-only differences.

## Which text files become ChoiceScript?

VS Code automatically changes plain-text files inside detected scene directories to the ChoiceScript language.
Unrelated `notes.txt` outside those directories remains ordinary text. JetBrains uses a project-aware file substitutor
rather than globally treating all text as game source.

You can explicitly select ChoiceScript for a standalone file. This supplies editing assistance, but does not create a
detected project or give that file a complete cross-scene context. Game commands still need a recognized game.

Do not add a global `"*.txt": "choicescript"` association unless you deliberately want every text file affected.
A narrow user-managed association is possible through editor settings, but project detection is usually sufficient.

## Assets and snapshots

Preview and test staging copies regular assets under `assets`, excluding generated/private paths and the scene
directory, then writes scene snapshots separately. Ordinary prose notes or unrelated files with innocuous names are not
automatically recognized as private. Prefer a dedicated asset directory when your game root contains design notes.

Open scene buffers are included even when unsaved. Non-scene assets are copied from disk;
save changes to images, stylesheets, and other assets before running. See [game tools](game-tools.md#what-a-run-contains) for consistency
and [data handling](data-and-execution.md)
for the copy boundary.

## Changes while the project is open

The server rediscovers projects and invalidates results through editor workspace/file notifications. Current limitations
include
directory-only removal events and configured scenes outside a watched workspace. If project membership or diagnostics
remain stale after a move, save files and reload/reopen the workspace. A project appearing in the picker does not prove
that all its files have completed analysis.

Contributors can inspect `choicescript/indexStatus` through the [protocol](protocol.md#index-status). It is a diagnostic
API, not a separate user-facing progress command.
