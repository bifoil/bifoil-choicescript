import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCoverage, normalizeCoverage } from "../coverage-report.mjs";

test("coverage normalization preserves known hits and records unmapped branches without inventing locations", () => {
  const input =
    "TN:\nSF:packages\\core\\src\\parser.ts\nDA:1,2\nBRDA:1,0,0,0\nBRDA:undefined,1,0,22\nBRDA:1,2,0,3\nBRF:3\nBRH:2\nend_of_record\n";
  const report = normalizeCoverage(input);
  assert.match(report.lcov, /SF:packages\/core\/src\/parser.ts/);
  assert.match(report.lcov, /DA:1,2/);
  assert.match(report.lcov, /BRDA:1,0,0,0/);
  assert.match(report.lcov, /BRDA:1,2,0,3/);
  assert.match(report.lcov, /BRF:2\nBRH:1/);
  assert(!report.lcov.includes("undefined"));
  assert.deepEqual(report.unmappedBranches, [{ file: "packages/core/src/parser.ts", record: "BRDA:undefined,1,0,22" }]);
});

test("coverage keeps original adapter code and omits generated data, third-party code and tests", () => {
  const files = [
    "packages/core/src/environment-binary.ts",
    "vendor/runtime-files.json",
    "scripts/test/example.test.mjs",
    "editors/vscode/src/extension.ts",
  ];
  const report = normalizeCoverage(files.map((file) => `SF:${file}\nDA:1,1\nend_of_record\n`).join(""));
  assert.deepEqual(report.excludedFiles, files.slice(0, 3));
  assert.match(report.lcov, /SF:editors\/vscode\/src\/extension.ts/);
  assert.throws(
    () => normalizeCoverage("SF:packages/core/src/parser.ts\nDA:undefined,1\nend_of_record"),
    /Invalid source-located/,
  );
  assert.throws(
    () => normalizeCoverage("SF:packages/core/src/parser.ts\nBRDA:0,1,0,1\nend_of_record"),
    /Invalid source-located/,
  );
});

test("cross-host coverage unions actual hits and rejects mismatched source coordinates", () => {
  const report = (hits = 0) =>
    "SF:scripts/coverage-report.mjs\nDA:1," +
    hits +
    "\nDA:2,0\nBRDA:1,0,0," +
    hits +
    "\nBRDA:1,0,1,-\nBRF:2\nBRH:0\nend_of_record\n";
  const result = mergeCoverage([report(), report(2)]);
  assert.match(result, /DA:1,2/);
  assert.match(result, /BRDA:1,0,0,2/);
  assert.match(result, /BRH:1/);
  assert.match(result, /LF:2\nLH:1/);
  assert.throws(() => mergeCoverage([]), /at least one/);
  assert.throws(() => mergeCoverage([""]), /no maintained source/);
  assert.throws(() => mergeCoverage([report() + report()]), /Duplicate LCOV source/);
  assert.throws(() => mergeCoverage([report(), report().replace("DA:2,0\n", "")]), /different source counters/);
  assert.throws(
    () => mergeCoverage([report(), report().replace("BRDA:1,0,0", "BRDA:2,0,0")]),
    /different source counters/,
  );
  assert.throws(
    () => mergeCoverage([report(), report().replace("coverage-report.mjs", "other.mjs")]),
    /different source counters/,
  );
  assert.throws(() => mergeCoverage([report().replace("DA:2,0", "DA:1,0")]), /duplicate LCOV counter/);
  assert.throws(() => mergeCoverage([report(Number.MAX_SAFE_INTEGER), report(1)]), /counter overflow/);
  assert.throws(() => mergeCoverage([report(Number.MAX_SAFE_INTEGER + 1)]), /duplicate LCOV counter/);
});
