import assert from "node:assert/strict";
import { test } from "node:test";
import { joinValue, sceneName, type Value } from "../src/types.js";

test("scene names preserve decoded case and handle empty final URI segments", () => {
  for (const [uri, expected] of [
    ["", ""],
    ["file:///original/scenes/", ""],
    ["file:///original/scenes/Chapter.TxT", "Chapter"],
    ["file:///original/scenes/%CE%A9%20chapter.txt", "Ω chapter"],
    ["file:///original/scenes/name%2Fpart.txt", "name/part"],
    ["file:///original/scenes/100%25.txt", "100%"],
  ])
    assert.equal(sceneName(uri), expected);
  assert.throws(() => sceneName("file:///original/scenes/%E0.txt"), URIError);
});

test("joining incomparable type envelopes preserves their common known primitive without mutating inputs", () => {
  const left: Value = { types: ["number", "string"], constant: 3 };
  const right: Value = { types: ["boolean", "number"], constant: 3 };
  const expected: Value = { types: ["boolean", "number", "string"], constant: 3 };
  assert.deepEqual(joinValue(left, right), expected);
  assert.deepEqual(joinValue(right, left), expected);
  assert.deepEqual(left, { types: ["number", "string"], constant: 3 });
  assert.deepEqual(right, { types: ["boolean", "number"], constant: 3 });
});
