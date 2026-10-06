import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeProject,
  definition,
  evaluate,
  literal,
  parseDocument,
  prepareRename,
  references,
  rename,
} from "@bifoil/choicescript-core";

const uri = "file:///audit/scenes/startup.txt";

const analyze = (text: string) => analyzeProject([{ uri, text }]);

const token = (a: ReturnType<typeof analyze>, line: number, column: number) =>
  a.tokens.get(uri)!.find((t) => t.line === line && t.start <= column && column < t.start + t.length);

const errors = (a: ReturnType<typeof analyze>) => a.diagnostics.get(uri)!.filter((d) => d.severity === 1);

test("parenthesized assignment keeps every rename reference and unrelated types", () => {
  const a = analyze('*create score 40\n*create name "Alex"\n*set score (score + 1)\n*print score\nHello \${name}');

  assert.deepEqual(errors(a), []);
  assert.equal(token(a, 2, 5)?.type, "numberVariable");
  assert.equal(token(a, 3, 7)?.type, "numberVariable");
  assert.equal(token(a, 4, 8)?.type, "stringVariable");

  const edit = rename(a, uri, { line: 0, character: 9 }, "points")!;

  assert.equal(edit.changes[uri].length, 4);
  assert(edit.changes[uri].some((e) => e.range.start.line === 2 && e.range.start.character === 5));
});

test("declaration names are plain identifiers even when they name builtin functions", () => {
  for (const name of ["score", "round", "length", "not"]) {
    const a = analyze("*create " + name + " 1\n*temp " + name + " (1 + 2)\n*set " + name + " +1\n*print " + name);

    assert.deepEqual(errors(a), []);
    assert.equal(token(a, 1, 6)?.type, "numberVariable");
    assert.equal(token(a, 3, 7)?.symbol, "local:" + uri + ":" + name);
    assert.equal(definition(a, uri, { line: 3, character: 7 })?.range.start.line, 1);
    assert.equal(rename(a, uri, { line: 1, character: 7 }, "localvalue")!.changes[uri].length, 3);
  }

  assert(parseDocument(uri, "*print unknown(1)").diagnostics.some((d) => d.severity === 1));
});

test("setref consumes a complete value target and shorthand reads the destination", () => {
  const lookup = (name: string) => literal(name === "score" ? 40 : name === "pointer" ? "score" : "ore");

  for (const [target, operation, expected] of [
    ["pointer", "-1", 39],
    ["pointer", "+1", 41],
    ["pointer", "*2", 80],
    ['("score")', "/2", 20],
    ['("sc" & suffix)', ' &"!"', "40!"],
    ['("score")', "modulo 3", 1],
    ['("score")', "3", 3],
  ] as const) {
    const text =
      '*create score 40\n*create pointer "score"\n*create suffix "ore"\n*setref ' +
      target +
      " " +
      operation +
      "\n*print score\n*print pointer";
    const a = analyze(text);

    assert.deepEqual(errors(a), [], target + " " + operation);
    assert.equal(evaluate(a.documents.get(uri)!.lines[3].expr, lookup).constant, expected);
    assert.equal(token(a, 4, 7)?.type, typeof expected === "string" ? "stringVariable" : "numberVariable");
    assert.equal(token(a, 5, 7)?.type, "stringVariable");
  }

  for (const operation of ["%+20", "%-20"]) {
    const a = analyze('*create score 40\n*create pointer "score"\n*setref pointer ' + operation + "\n*print score");

    assert.deepEqual(errors(a), []);
    assert.equal(token(a, 3, 7)?.type, "numberVariable");
  }

  assert.deepEqual(parseDocument(uri, '*setref length("abc") 3').diagnostics, []);
});

test("assignment shorthand preserves array and indirect destination values", () => {
  for (const target of ["items[1]", '{"items_1"}']) {
    const a = analyze("*create_array items 1 40\n*set " + target + ' &"!"\n*print items_1');

    assert.deepEqual(errors(a), []);
    assert.equal(token(a, 2, 7)?.type, "stringVariable");
  }
});

test("mixed-case comments preserve branch association without recognizing command prefixes", () => {
  for (const command of ["comment", "COMMENT", "Comment"]) {
    const a = analyze(
      '*create implicit_control_flow true\n*create flag true\n"Hello\n*if flag\n  A."\n*' +
        command +
        ' between alternatives\n*else\n  B."\nOutside.',
    );

    assert.deepEqual(a.diagnostics.get(uri), []);
    assert.equal(a.documents.get(uri)!.lines[5].kind, "comment");
    assert.equal(token(a, 5, 1)?.type, "comment");
    assert(a.tokens.get(uri)!.some((t) => t.line === 5 && t.type === "comment"));
    assert(a.tokens.get(uri)!.some((t) => t.line === 8 && t.type === "narrative"));
  }

  const doc = parseDocument(uri, "*commentary other command");

  assert.equal(doc.lines[0].kind, "command");
  assert(doc.diagnostics.some((d) => d.code === "unknown-command"));
});

test("array-like local scalars retain complete ranges and reveal the array after deletion", () => {
  const a = analyze(
    '*create_array items 2 10\r\n*print items_1\r\n*temp items_1 "local"\r\n*print items_1\r\n*delete items_1\r\n*print items_1',
  );

  assert.deepEqual(errors(a), []);
  assert.equal(definition(a, uri, { line: 1, character: 8 })?.range.start.line, 0);
  assert.equal(definition(a, uri, { line: 3, character: 8 })?.range.start.line, 2);
  assert.equal(definition(a, uri, { line: 5, character: 8 })?.range.start.line, 0);
  assert.equal(token(a, 3, 8)?.type, "stringVariable");
  assert.equal(token(a, 5, 8)?.type, "numberVariable");
  assert.equal(token(a, 2, 7)?.referenceLength, undefined);
  assert.equal(prepareRename(a, uri, { line: 2, character: 7 })?.end.character, 13);
  assert.equal(references(a, uri, { line: 2, character: 7 }).length, 3);

  for (const reference of references(a, uri, { line: 2, character: 7 }))
    assert.equal(reference.range.end.character - reference.range.start.character, "items_1".length);

  // Renaming a shadow of an implicitly created runtime name remains deliberately conservative.
  assert.throws(() => rename(a, uri, { line: 2, character: 7 }, "first"), /overlaps/);
});

test("generated array references select the active array scope", () => {
  const a = analyze('*create_array items 1 "global"\n*print items_1\n*temp_array items 1 3\n*print items_1');

  assert.equal(definition(a, uri, { line: 1, character: 8 })?.range.start.line, 0);
  assert.equal(definition(a, uri, { line: 3, character: 8 })?.range.start.line, 2);
  assert.equal(token(a, 1, 8)?.type, "stringVariable");
  assert.equal(token(a, 3, 8)?.type, "numberVariable");
});
