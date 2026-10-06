import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeProject, references, rename } from "@bifoil/choicescript-core";

const uri = "file:///game/scenes/startup.txt";
const chapter = "file:///game/scenes/chapter.txt";

const analyze = (text: string, next?: string) =>
  analyzeProject([{ uri, text }, ...(next === undefined ? [] : [{ uri: chapter, text: next }])]);

const at = (a: ReturnType<typeof analyze>, file: string, line: number, column: number) =>
  a.tokens
    .get(file)
    ?.find((token) => token.line === line && token.start <= column && token.start + token.length > column);

test("global rename rejects capture by a local in another affected scene", () => {
  const a = analyze("*create score 1\n*goto_scene chapter", "*temp points 0\n*print score");

  assert.throws(() => rename(a, uri, { line: 0, character: 9 }, "points"), /already exists/);
  assert(rename(a, uri, { line: 0, character: 9 }, "total"));
});

test("string interpolation references preserve escaped UTF-16 source positions", () => {
  const text =
    '*create name "Alex"\r\n*temp greeting "😀 \\"Hello\\" \${name}; @{true \${name}|x}"\r\n*print "Again \${name}"';
  const a = analyze(text);
  const edit = rename(a, uri, { line: 0, character: 9 }, "guest")!;

  assert.equal(edit.changes[uri].length, 4);

  const lines = text.split(/\r?\n/);

  for (const change of edit.changes[uri])
    assert.equal(
      lines[change.range.start.line].slice(change.range.start.character, change.range.end.character),
      "name",
    );

  assert.equal(at(a, uri, 1, lines[1].indexOf("\${name}") + 2)?.type, "stringVariable");
  assert.equal(references(a, uri, { line: 0, character: 9 }, false).length, 3);
  assert.deepEqual(a.diagnostics.get(uri), []);
});

test("rename and declarations reject interpreter-reserved variable names", () => {
  const a = analyze("*create value 1\n*print value");

  for (const name of ["and", "OR", "true", "false", "scene", "scenename", "choice_test"]) {
    assert.throws(() => rename(a, uri, { line: 0, character: 9 }, name), /reserved/);
    assert(
      analyze("*create " + name + " 1")
        .diagnostics.get(uri)
        ?.some((d) => d.code === "variable-name"),
    );
  }

  const labels = analyze("*label scene\n*goto scene");

  assert(rename(labels, uri, { line: 0, character: 8 }, "true"));
});

test("startup is implicit in scene_list and EOF transfers dialogue and global types", () => {
  for (const ending of ["*finish", ""]) {
    const a = analyze('*create score 1\n*scene_list\n  chapter\n"Hello\n' + ending, 'friend."\n*print score\n*ending');

    assert.equal(at(a, chapter, 0, 0)?.type, "dialogue");
    assert.equal(at(a, chapter, 1, 8)?.type, "numberVariable");
    assert(![...a.diagnostics.values()].flat().some((d) => d.code.startsWith("quote-")));
  }
});

test("delete and delete_array remove the active scope, revealing globals", () => {
  const a = analyze(
    '*create value 1\n*create_array names 1 2\n*temp value "local"\n*delete value\n*print value\n*temp_array names 1 "local"\n*delete_array names\n*print names[1]\n*print names_1',
  );

  assert.equal(at(a, uri, 4, 8)?.type, "numberVariable");
  assert.equal(at(a, uri, 7, 8)?.type, "numberVariable");
  assert.equal(at(a, uri, 8, 8)?.type, "numberVariable");
});

test("same-scene gosub arguments are evaluated before resetting callee locals", () => {
  const a = analyze(
    '*temp value "text"\n*gosub_scene startup helper value\n*ending\n*label helper\n*params received\n*print received\n*return',
  );

  assert.equal(at(a, uri, 5, 8)?.type, "stringVariable");
});

test("params expose anonymous values and their count in local scope", () => {
  const a = analyze(
    '*gosub helper 123 "text"\n*ending\n*label helper\n*params received\n*print received\n*print param_1\n*print param_2\n*print param_count\n*return',
  );

  assert.equal(at(a, uri, 4, 8)?.type, "numberVariable");
  assert.equal(at(a, uri, 5, 8)?.type, "numberVariable");
  assert.equal(at(a, uri, 6, 8)?.type, "stringVariable");
  assert.equal(at(a, uri, 7, 8)?.type, "numberVariable");
});

test("random-scene metadata resolves whole scene names and conditional references", () => {
  const next = "file:///game/scenes/β.chapter.txt";
  const a = analyzeProject([
    { uri, text: '*create score 1\n*create ready true\n"Hello\n*goto_random_scene\n  *if (ready) β.chapter' },
    { uri: next, text: 'friend."\n*print score\n*ending' },
  ]);

  assert.equal(at(a, next, 0, 0)?.type, "dialogue");
  assert.equal(at(a, next, 1, 8)?.type, "numberVariable");
  assert.equal(references(a, uri, { line: 1, character: 10 }).length, 2);

  const sceneToken = a.tokens.get(uri)?.find((t) => t.line === 4 && t.type === "label");

  assert.equal(sceneToken?.symbol, "scene:β.chapter");
});

test("inherited object property names are unknown commands", () => {
  for (const command of ["constructor", "__proto__"]) {
    assert(
      analyze("*" + command + " value")
        .diagnostics.get(uri)
        ?.some((d) => d.code === "unknown-command"),
    );
  }
});

test("finish and EOF start the next scene with fresh local variables after a subroutine visit", () => {
  for (const finish of ["*finish", ""]) {
    const a = analyze(
      "*create value 1\n*scene_list\n  chapter\n*gosub_scene chapter setup\n" + finish,
      '*print value\n*ending\n*label setup\n*temp value "local"\n*return',
    );

    assert.equal(at(a, chapter, 0, 8)?.type, "numberVariable");
  }
});

test("Unicode case normalization does not expand the source range of a scene token", () => {
  const a = analyze("*goto_random_scene\n  İ.chapter");
  const token = a.tokens.get(uri)?.find((t) => t.line === 1 && t.type === "label")!;

  assert.equal(token.length, "İ.chapter".length);
  assert(token.start + token.length <= a.documents.get(uri)!.lines[1].raw.length);
});

test("rename refuses generated parameter and array namespaces", () => {
  const params = analyze("*create score 1\n*gosub helper 2\n*ending\n*label helper\n*params\n*print score\n*return");

  for (const name of ["param_1", "param_count"])
    assert.throws(() => rename(params, uri, { line: 0, character: 9 }, name), /already exists/);

  assert(rename(params, uri, { line: 0, character: 9 }, "total"));

  const array = analyze("*create_array score 1 1\n*create points_1 3\n*print score[1]\n*ending");

  assert.throws(() => rename(array, uri, { line: 0, character: 15 }, "points"), /already exists/);

  const scalar = analyze("*create score 1\n*create_array points 1 3\n*print score\n*ending");

  assert.throws(() => rename(scalar, uri, { line: 0, character: 9 }, "points_1"), /already exists/);
  assert(rename(scalar, uri, { line: 0, character: 9 }, "total"));

  const overlap = analyze("*create_array score 1 1\n*create score_1 3\n*print score[1]\n*ending");

  assert.throws(() => rename(overlap, uri, { line: 0, character: 15 }, "points"), /overlaps/);
  assert.throws(() => rename(overlap, uri, { line: 1, character: 9 }, "points"), /overlaps/);

  const explicitParam = analyze(
    "*gosub helper 2\n*ending\n*label helper\n*params\n*print param_1\n*temp param_1 3\n*print param_1\n*return",
  );

  assert.throws(() => rename(explicitParam, uri, { line: 5, character: 7 }, "renamed"), /overlaps/);

  const label = analyze("*create_array points 1 1\n*label points_1\n*goto points_1");

  assert(rename(label, uri, { line: 1, character: 8 }, "destination"));
});
