import assert from "node:assert/strict";
import { test } from "node:test";
import { toolDiagnostic } from "../src/tool-diagnostic.js";

test("official diagnostics preserve filenames, Unicode messages and one-based line conversion", () => {
  assert.deepEqual(toolDiagnostic("RANDOMTEST FAILED: Error: chapter line notes line 12: Something\u2028happened"), {
    scene: "chapter line notes",
    line: 11,
    message: "Something\u2028happened",
    prefixed: true,
    warning: false,
  });
  assert.equal(toolDiagnostic("WARNING chapter.txt line 1: A warning")?.warning, true);
  assert.equal(toolDiagnostic("chapter line 2: WARNING example")?.warning, true);
  assert.equal(toolDiagnostic("chapter line 0: no source row"), undefined);
  assert.equal(toolDiagnostic("chapter line 999999999999999999999: invalid"), undefined);
});

test("large failed diagnostic candidates are scanned without backtracking", { timeout: 1000 }, () => {
  const repeated = "chapter line 1: text\u2028".repeat(20_000);
  assert.equal(toolDiagnostic(repeated)?.message, repeated.slice("chapter line 1: ".length));
  const parsed = toolDiagnostic("chapter" + " line invalid".repeat(40_000) + " line 9: Error");
  assert.equal(parsed?.line, 8);
  assert.equal(parsed?.message, "Error");
});
