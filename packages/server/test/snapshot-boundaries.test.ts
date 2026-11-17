import assert from "node:assert/strict";
import { deserialize, serialize } from "node:v8";
import { deflateSync, inflateSync } from "node:zlib";
import { test } from "node:test";
import { analyzeProject } from "@bifoil/choicescript-core";
import {
  type FeatureCache,
  mergeSnapshot,
  packAnalysis,
  requestAnalysis,
  snapshotFolding,
  snapshotBuffers,
  snapshotTokens,
  unpackAnalysis,
  updatePlainProse,
} from "../src/snapshots.js";

const uri = "file:///original/scenes/startup.txt";
const before = "*create score 1\nOriginal prose.\n*ending";
const after = before.replace("Original prose.", "Expanded original prose.");
const snapshot = () => packAnalysis(analyzeProject([{ uri, text: before, version: 1 }]), false);

// Inconsistent reusable indexes must request a complete analysis instead of
// publishing a plausible partial result from a damaged or stale chunk.
test("prose shortcuts reject inconsistent query chunks without mutating their baseline", () => {
  assert.throws(() => unpackAnalysis(snapshot()), /does not contain a syntax tree/);
  assert.equal(updatePlainProse(snapshot(), uri, "wrong physical inventory", after, 1, 2), undefined);
  assert.deepEqual(snapshotTokens(snapshot(), "file:///missing.txt"), { data: [] });
  assert.deepEqual(snapshotFolding(snapshot(), "file:///missing.txt"), []);
  const missingDocument = requestAnalysis(snapshot(), "file:///missing.txt", [{ line: 0, character: 0 }]);
  assert.equal(missingDocument.documents.size, 0);
  assert.equal(missingDocument.tokens.size, 0);
  const missing = snapshot();
  missing.features.get(uri)!.chunks.delete(0);
  assert.deepEqual(requestAnalysis(missing, uri, [{ line: 1, character: 2 }]).tokens.get(uri), []);
  assert.equal(updatePlainProse(missing, uri, before, after, 1, 2), undefined);

  type Chunk = {
    lines: { line: number; raw: string; kind: string }[];
    tokens: { line: number; start: number; length: number; type: string }[];
  };
  const changes: ((chunk: Chunk) => void)[] = [
    (chunk) => {
      chunk.lines = chunk.lines.filter((line) => line.line !== 1);
    },
    (chunk) => {
      chunk.lines.find((line) => line.line === 1)!.raw = "Stale original prose.";
    },
    (chunk) => {
      chunk.lines.find((line) => line.line === 1)!.kind = "command";
    },
    (chunk) => {
      chunk.tokens = chunk.tokens.filter((token) => token.line !== 1);
    },
    (chunk) => {
      chunk.tokens.find((token) => token.line === 1)!.type = "keyword";
    },
    (chunk) => {
      chunk.tokens.find((token) => token.line === 1)!.start++;
    },
    (chunk) => {
      chunk.tokens.find((token) => token.line === 1)!.length--;
    },
  ];
  for (const change of changes) {
    const original = snapshot(),
      feature = original.features.get(uri)!;
    const chunk: Chunk = deserialize(inflateSync(feature.chunks.get(0)!));
    change(chunk);
    feature.chunks.set(0, deflateSync(serialize(chunk)));
    const retained = serialize(original);
    assert.equal(updatePlainProse(original, uri, before, after, 1, 2), undefined);
    assert.deepEqual(serialize(original), retained);
  }
  const staleTokens = snapshot();
  staleTokens.features.get(uri)!.tokens = deflateSync(serialize({ data: [] }));
  assert.equal(updatePlainProse(staleTokens, uri, before, after, 1, 2), undefined);
});

test("removed documents leave neither worker cache entries nor accepted snapshot indexes", () => {
  const other = "file:///original/scenes/other.txt";
  const cache: FeatureCache = new Map();
  const input = [
    { uri, text: "Original main prose.", version: 1 },
    { uri: other, text: "Original other prose.", version: 1 },
  ];
  const initial = packAnalysis(analyzeProject(input), false, cache, true);
  const accepted = mergeSnapshot(undefined, structuredClone(initial, { transfer: snapshotBuffers(initial) }));
  assert.equal(cache.size, 2);

  const delta = packAnalysis(analyzeProject([input[0]]), false, cache, true);
  const reduced = mergeSnapshot(accepted, delta);
  assert.deepEqual([...cache.keys()], [uri]);
  assert.deepEqual([...reduced.features.keys()], [uri]);
  assert.deepEqual(reduced, packAnalysis(analyzeProject([input[0]]), false));

  const empty = mergeSnapshot(reduced, packAnalysis(analyzeProject([]), false, cache, true));
  assert.equal(cache.size, 0);
  assert.equal(empty.documents.size, 0);
  assert.equal(empty.features.size, 0);

  const restored = packAnalysis(analyzeProject(input), false, cache);
  assert.strictEqual(mergeSnapshot(empty, restored), restored);
  for (const source of input) {
    assert.deepEqual(snapshotTokens(restored, source.uri), snapshotTokens(accepted, source.uri));
  }
});

test("root comments create new query chunks at an exact chunk boundary", () => {
  const text = ["*create score 1", ...Array.from({ length: 255 }, () => "Original prose.")].join("\n");
  const original = packAnalysis(analyzeProject([{ uri, text, version: 1 }]), false);
  const changed = text + "\n*comment Original boundary comment";
  const updated = updatePlainProse(original, uri, text, changed, 1, 2);
  assert(updated);
  const fresh = packAnalysis(analyzeProject([{ uri, text: changed, version: 2 }]), false);
  assert.deepEqual(snapshotTokens(updated, uri), snapshotTokens(fresh, uri));
  assert.deepEqual(updated.wordCounts, fresh.wordCounts);
  assert.deepEqual(updated.diagnostics, fresh.diagnostics);
  assert.deepEqual(
    requestAnalysis(updated, uri, [{ line: 256, character: 1 }]).tokens,
    requestAnalysis(fresh, uri, [{ line: 256, character: 1 }]).tokens,
  );
});
