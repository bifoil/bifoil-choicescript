import { test } from "node:test";
import assert from "node:assert/strict";
import { overlaySegments } from "../src/spans.js";
import type { Span } from "@bifoil/choicescript-core";

test("a lone overlay is copied and empty overlays contribute no semantic span", () => {
  const token: Span = { line: 4, start: 2, length: 3, type: "variable" };
  const result = overlaySegments([], [token]);
  assert.deepEqual(result, [token]);
  assert.notEqual(result[0], token);
  result[0].length = 1;
  assert.equal(token.length, 3);
  for (const length of [0, -1]) assert.deepEqual(overlaySegments([], [{ ...token, length }]), []);
});

test("semantic overlays preserve nested token precedence and uncovered prose", () => {
  const span = (start: number, length: number, type: string): Span => ({ line: 0, start, length, type });

  const result = overlaySegments(
    [span(0, 12, "dialogue")],
    [span(4, 4, "interpolation"), span(5, 1, "variable"), span(2, 8, "string")],
  );

  assert.deepEqual(
    result.map(({ start, length, type }) => [start, length, type]),
    [
      [0, 2, "dialogue"],
      [2, 2, "string"],
      [4, 1, "interpolation"],
      [5, 1, "interpolation"],
      [6, 2, "interpolation"],
      [8, 2, "string"],
      [10, 2, "dialogue"],
    ],
  );
});

test("long-line semantic overlays use a bounded number of interval inspections", () => {
  const count = 20_000;
  let reads = 0;
  const tokens: Span[] = Array.from({ length: count }, (_, i) => ({
    line: 0,
    type: "number",
    get start() {
      reads++;
      return i * 2;
    },
    get length() {
      reads++;
      return 1;
    },
  }));
  const result = overlaySegments([], tokens);

  assert.equal(result.length, count);
  assert.equal(result.at(-1)!.start, (count - 1) * 2);
  assert(reads < count * 100, "Interval inspections must not grow quadratically");
});
