import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocument } from "../src/parser.js";

const uri = "file:///original/scenes/startup.txt";

test("an unquoted backslash does not hide the following inline option during recovery", () => {
  const first = "*if flag\\name # Original option";
  const doc = parseDocument(uri, first + "\nRecovered narrative.\n*ending");
  assert.equal(doc.lines[0].inlineText, first.indexOf("#") + 1);
  assert(doc.diagnostics.some((diagnostic) => diagnostic.code === "expression-character"));
  assert.equal(doc.lines[1].kind, "prose");
  assert.equal(doc.lines[2].command, "ending");
});

test("standalone reuse policies remain commands without inventing an inline option", () => {
  for (const command of ["hide_reuse", "disable_reuse", "allow_reuse"]) {
    const doc = parseDocument(uri, `*${command}\nOriginal narrative.\n*ending`);
    assert.deepEqual(doc.diagnostics, []);
    assert.equal(doc.lines[0].command, command);
    assert.equal(doc.lines[0].inlineText, undefined);
    assert.equal(doc.lines[1].kind, "prose");
  }
});

test("escaped string diagnostics map back to bounded original UTF-16 columns", () => {
  for (const prefix of ["", "Original 😀 ", '\\"Quoted\\" ', "\\\\path "]) {
    for (const expression of ["${", "${(}", "${round(}", "@{}", "@{true}"]) {
      const line = `*print "${prefix}${expression}"`;
      const doc = parseDocument(uri, line + "\nRecovered narrative.\n*ending");
      assert(doc.diagnostics.length > 0, line);
      for (const { range } of doc.diagnostics) {
        assert.equal(range.start.line, 0, line);
        assert.equal(range.end.line, 0, line);
        assert(range.start.character >= 8 && range.end.character >= range.start.character, line);
        assert(range.end.character <= line.length, line);
      }
      assert.equal(doc.lines[1].kind, "prose");
      assert.equal(doc.lines[2].command, "ending");
    }
  }
});
