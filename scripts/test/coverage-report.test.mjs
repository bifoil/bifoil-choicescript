import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCoverage } from "../coverage-report.mjs";

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
