# Editor workflow validation

The real VS Code 1.109.0 extension-host test loads an extracted VSIX into an isolated profile and temporary game directory. It checks both light/dark semantic classifications, completion, definition, rename, unrelated text, bold/italic commands, comment toggling, indentation, snippets, word count, unsaved-buffer preview, webview tab creation and stale title, restart/stop, QuickTest, seeded RandomTest, coverage events, saved logs, cancellation, export and template creation. Workflow events and editor logs are retained as CI artifacts.

The native JetBrains tests launch the bundled server in each IDE SDK, check theme-derived attributes and semantic parity, completion/rename and trust refusal, and exercise formatting actions, comment toggling, indentation and registered live templates. The shared packaged-runtime tests additionally check clickable failure locations, process exit, saved output, stale results and staging cleanup on all six operating-system/CPU targets.

## Manual visual gates

These checks are **not yet recorded as passed**. Automated token and command tests cannot establish visual readability, browser behavior, or JCEF rendering. Keep releases private and marked as prereleases until a tester records the exact artifact checksum, IDE version, OS/CPU, date and result for each row.

| Check | VS Code | JetBrains |
| --- | --- | --- |
| Dialogue/variable colors readable in light and dark themes | Pending visual review | Pending visual review |
| Embedded game paints correctly and choices advance | Pending webview walkthrough | Pending JCEF walkthrough |
| Open in browser works; JCEF-unavailable fallback works | Pending | Pending |
| Failure links navigate to the reported scene line | Pending click verification | Pending click verification |
| Progress cancellation and coverage presentation are understandable | Pending visual review | Pending visual review |
| Close preview, restart, close editor: no surviving owned jobs | Automated server checks; UI review pending | Automated server checks; UI review pending |

Use the required dialogue fixture and run both `gender` values. Include malformed expression strings inside open dialogue, edit an unsaved scene, restart, cancel a long RandomTest, click a failure, and export to a new destination. Preserve existing output files when testing export collisions.

## Programmatic VS Code commands

Tool commands accept an optional object with `projectId`, `destination`, `iterations`, `seed` and `jobId`. Create Project also accepts `openCreatedProject: false`. Missing interactive choices still prompt normally. Arguments cannot override workspace trust, the operation or protocol version. Commands return their `JobResult`; test/export commands finish after job completion. The extension API exposes `projects()` and `onJobEvent` for integrations. Word Count returns the count as well as showing it.
