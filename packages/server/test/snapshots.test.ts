import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeProject,
  completions,
  definition,
  documentSymbols,
  encodeTokens,
  folding,
  hover,
  prepareRename,
  references,
  rename,
  selections,
} from "@bifoil/choicescript-core";
import {
  mergeSnapshot,
  packAnalysis,
  requestAnalysis,
  snapshotBuffers,
  snapshotFolding,
  snapshotTokens,
  unpackAnalysis,
  updatePlainProse,
} from "../src/snapshots.js";

test("worker snapshots preserve complete cyclic syntax trees, Unicode ranges, diagnostics and symbols", () => {
  const analysis = analyzeProject([
    {
      uri: "file:///original%20%CE%A9/scenes/startup.txt",
      version: 7,
      text: [
        '*create gender "male"',
        "*create implicit_control_flow true",
        "*create_array scores 2 0",
        '*setref "scores_1" 7',
        'She said "An ending 😀,',
        '*if gender = "male"',
        '    William."',
        "*else",
        '    Belle."',
        "*label final",
        "*ending",
      ].join("\r\n"),
    },
  ]);
  const snapshot = packAnalysis(analysis);
  const transferred = structuredClone(snapshot, { transfer: snapshotBuffers(snapshot) });

  assert.equal(snapshot.data!.byteLength, 0);

  const restored = unpackAnalysis(transferred);

  assert.deepEqual(restored, analysis);

  const document = [...restored.documents.values()][0];
  const branch = document.lines.find((line) => line.command === "if")!;

  assert.strictEqual(branch.children[0].parent, branch);
  assert.strictEqual(document.lines[branch.children[0].line], branch.children[0]);
  assert.equal(transferred.documents.get(document.uri)?.version, 7);
});

test("compact request indexes match full analysis for navigation, rename, Unicode, and distant lines", () => {
  const uri = "file:///original/scenes/startup.txt",
    helper = "file:///original/scenes/helper.txt";
  const analysis = analyzeProject([
    {
      uri,
      text: [
        "*create score 1",
        "*create_array scores 2 0",
        "*create implicit_control_flow true",
        '*temp greeting "😀"',
        "Say $" + "{greeting}.",
        ...Array.from({ length: 520 }, (_, i) => (i % 2 ? "A plain paragraph." : "*set score + 1")),
        "*print score",
        "*gosub_scene helper entry score",
        "*ending",
      ].join("\r\n"),
      version: 2,
    },
    { uri: helper, text: "*label entry\n*params value\n*print value\n*return", version: 5 },
  ]);
  const snapshot = structuredClone(packAnalysis(analysis, false));

  for (const source of [uri, helper]) {
    assert.deepEqual(snapshotTokens(snapshot, source), encodeTokens(analysis, source));
    assert.deepEqual(snapshotFolding(snapshot, source), folding(analysis, source));
    assert.deepEqual(documentSymbols(requestAnalysis(snapshot, source), source), documentSymbols(analysis, source));

    for (const line of [0, 1, 4, 255, 256, 520, 525].filter((n) => n < analysis.documents.get(source)!.lines.length)) {
      for (const character of [0, 8, 11]) {
        const position = { line, character },
          view = requestAnalysis(snapshot, source, [position], true);

        assert.deepEqual(hover(view, source, position), hover(analysis, source, position));
        assert.deepEqual(completions(view, source, position), completions(analysis, source, position));
        assert.deepEqual(definition(view, source, position), definition(analysis, source, position));
        assert.deepEqual(references(view, source, position, false), references(analysis, source, position, false));
        assert.deepEqual(prepareRename(view, source, position), prepareRename(analysis, source, position));
        assert.deepEqual(selections(view, source, [position]), selections(analysis, source, [position]));
        assert.deepEqual(rename(view, source, position, "renamed"), rename(analysis, source, position, "renamed"));
      }
    }
  }

  const arrayPosition = { line: 1, character: 15 };
  const view = requestAnalysis(snapshot, uri, [arrayPosition], true);

  assert.throws(() => rename(view, uri, arrayPosition, "score"), /exists/);

  const overlapping = analyzeProject([{ uri, text: "*create_array scores 2 0\n*create scores_1 2\n*print scores_1" }]);
  const compact = requestAnalysis(packAnalysis(overlapping, false), uri, [{ line: 2, character: 10 }], true);

  assert.throws(() => rename(compact, uri, { line: 2, character: 10 }, "renamed"), /overlaps/);
});

test("incremental plain prose matches complete analysis and rejects changes to narrative or syntax state", () => {
  const uri = "file:///original/scenes/startup.txt";

  for (const text of [
    "*create value true\nOrdinary words.\n*ending",
    '*create value true\n"Open\nStill speaking\nClose."\n*ending',
    '*create value true\n*create implicit_control_flow true\n*if value\n    "Open\n*else\n    Outside\nThe continuation\n*ending',
    '"Open\nA final paragraph',
  ]) {
    const line = text.split("\n").findIndex((raw) => /Ordinary|Still speaking|The continuation|A final/.test(raw));
    const rows = text.split("\n"),
      old = rows[line];
    const analysis = analyzeProject([{ uri, text, version: 1 }]),
      snapshot = packAnalysis(analysis, false);
    rows[line] = old + " Ω 😀 don't";

    const changed = rows.join("\n");
    const updated = updatePlainProse(snapshot, uri, text, changed, 1, 7);

    assert(updated);

    const full = packAnalysis(analyzeProject([{ uri, text: changed, version: 7 }]), false);

    assert.deepEqual(snapshotTokens(updated, uri), snapshotTokens(full, uri));
    assert.deepEqual(updated.diagnostics, full.diagnostics);
    assert.deepEqual(updated.wordCounts, full.wordCounts);
    assert.deepEqual(
      requestAnalysis(updated, uri, [{ line, character: old.length }], true),
      requestAnalysis(full, uri, [{ line, character: old.length }], true),
    );
    assert.equal(snapshot.features.get(uri)!.version, 1, "the earlier snapshot stays immutable");
    assert.deepEqual(snapshotTokens(snapshot, uri), encodeTokens(analysis, uri));

    for (const replacement of [
      '"Changed',
      "$" + "{value}",
      "[b]Changed[/b]",
      "*set value false",
      "#Choice",
      "    " + old,
      "",
    ]) {
      const rejected = [...text.split("\n")];
      rejected[line] = replacement;

      assert.equal(updatePlainProse(snapshot, uri, text, rejected.join("\n"), 1, 2), undefined, replacement);
    }

    assert.equal(updatePlainProse(snapshot, uri, text, changed, 0, 2), undefined);
    assert.equal(updatePlainProse(snapshot, uri, text, text + "\nAnother line", 1, 2), undefined);
  }
});

test("reused request indexes survive transfers and same-version source changes", () => {
  const uri = "file:///original/scenes/startup.txt";
  const cache = new Map();
  const text = "*create value 7\nOrdinary prose.\n*print value";
  const full = analyzeProject([{ uri, text, version: 1 }]);
  const first = structuredClone(packAnalysis(full, false, cache));
  const next = packAnalysis(analyzeProject([{ uri, text, version: 1 }]), false, cache);
  const transferred = structuredClone(next, { transfer: snapshotBuffers(next) });

  assert.deepEqual(transferred, first);

  const changed = text.replace("Ordinary prose.", "Different text.");
  const fresh = packAnalysis(analyzeProject([{ uri, text: changed, version: 1 }]), false, cache);
  const expected = packAnalysis(analyzeProject([{ uri, text: changed, version: 1 }]), false);

  assert.deepEqual(fresh, expected);

  const update = packAnalysis(
    analyzeProject([{ uri, text: text.replace("value 7", "value true"), version: 2 }]),
    false,
    cache,
  );

  assert.deepEqual(
    snapshotTokens(update, uri),
    encodeTokens(analyzeProject([{ uri, text: text.replace("value 7", "value true"), version: 2 }]), uri),
  );
  assert.deepEqual(snapshotTokens(first, uri), encodeTokens(full, uri));
});

test("worker deltas reuse only version-matching indexes and preserve changed variable colors", () => {
  const uri = "file:///original/scenes/startup.txt",
    other = "file:///original/scenes/other.txt",
    cache = new Map();
  const input = [
    { uri, text: "*create value 7\n*goto_scene other", version: 1 },
    { uri: other, text: "*print value\n*ending", version: 1 },
  ];
  const initial = packAnalysis(analyzeProject(input), false, cache, true);
  const accepted = mergeSnapshot(undefined, structuredClone(initial, { transfer: snapshotBuffers(initial) }));
  const unchanged = packAnalysis(analyzeProject(input), false, cache, true);

  assert.equal(unchanged.features.size, 0);
  assert.equal(unchanged.reuseFeatures?.length, 2);
  assert.deepEqual(mergeSnapshot(accepted, unchanged), packAnalysis(analyzeProject(input), false));
  assert.throws(() => mergeSnapshot(undefined, unchanged), /index is missing/);

  const changed = [{ ...input[0], text: input[0].text.replace("value 7", "value true"), version: 2 }, input[1]];
  const next = packAnalysis(analyzeProject(changed), false, cache, true);
  const merged = mergeSnapshot(accepted, structuredClone(next, { transfer: snapshotBuffers(next) }));

  assert.deepEqual(snapshotTokens(merged, other), encodeTokens(analyzeProject(changed), other));
  assert.deepEqual(merged, packAnalysis(analyzeProject(changed), false));
});

test("ordinary requests decode only their source while rename keeps every collision header", () => {
  const uri = "file:///original/scenes/startup.txt",
    other = "file:///original/scenes/other.txt";
  const analysis = analyzeProject([
    { uri, text: "*create value 7\n*goto_scene other" },
    { uri: other, text: "*temp_array scores 2 0\n*print value" },
  ]);
  const snapshot = packAnalysis(analysis, false),
    position = { line: 0, character: 9 };
  const one = requestAnalysis(snapshot, uri, [position]);

  assert.equal(one.documents.size, 1);
  assert.deepEqual(hover(one, uri, position), hover(analysis, uri, position));
  assert.equal(requestAnalysis(snapshot, uri, [position], true).documents.size, 2);
});
