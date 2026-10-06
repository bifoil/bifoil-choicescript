import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { analyzeProject, definition, literal, parseDocument, rename } from "@bifoil/choicescript-core";
import { Environment } from "../src/environment.js";

// Synthetic examples derived from language constructs, not copies of game text.
const uri = "file:///corpus/scenes/startup.txt";

const analyze = (text: string) => analyzeProject([{ uri, text }]);

function engine() {
  const context = vm.createContext({ console });

  for (const name of ["scene", "util"])
    vm.runInContext(
      readFileSync(new URL(`../../../vendor/choicescript/web/${name}.js`, import.meta.url), "utf8"),
      context,
    );

  vm.runInContext('scene = new Scene("startup", {flag: true, name: "Alex"})', context);

  return context;
}

function token(a: ReturnType<typeof analyze>, line: number, character: number) {
  return a.tokens.get(uri)!.find((t) => t.line === line && t.start <= character && t.start + t.length > character)
    ?.type;
}

test("multireplace dialogue punctuation follows the interpreter's raw brace matching", () => {
  const context = engine();

  for (const [source, expected] of [
    ['"@{flag Ready."|Wait."}', '"Ready."'],
    ['@{flag "Ready.|No.}', '"Ready.'],
    ['"@{(flag) ${name}, ready."|Wait."}', '"Alex, ready."'],
  ]) {
    assert.equal(vm.runInContext(`scene.replaceVariables(${JSON.stringify(source)})`, context), expected);
    assert.deepEqual(parseDocument(uri, source).diagnostics, []);
  }

  // Raw braces in a quoted expression also delimit interpolation in the engine.
  const malformed = '${"}"}';

  assert.throws(() => vm.runInContext(`scene.replaceVariables(${JSON.stringify(malformed)})`, context));
  assert(parseDocument(uri, malformed).diagnostics.some((d) => d.code === "expression-string"));
});

test("each multireplace alternative inherits dialogue and closes it independently", () => {
  const line = '"@{flag Ready."|Wait."} Outside.';
  const a = analyze("*create flag true\n" + line + "\nOrdinary prose.");

  for (const word of ["Ready", "Wait"]) assert.equal(token(a, 1, line.indexOf(word)), "dialogue");

  assert.equal(token(a, 1, line.indexOf("flag")), "booleanVariable");
  assert.equal(token(a, 1, line.indexOf("Outside")), "narrative");
  assert.equal(token(a, 2, 0), "narrative");
  assert.deepEqual(a.diagnostics.get(uri), []);
});

test("nested interpolation in alternatives never treats expression quotes as dialogue", () => {
  const line = '"@{flag ${"friend"}, ready."|Wait."} Outside.';
  const a = analyze("*create flag true\n" + line);

  assert.equal(token(a, 1, line.indexOf("friend")), "string");
  assert.equal(token(a, 1, line.indexOf("ready")), "dialogue");
  assert.equal(token(a, 1, line.indexOf("Outside")), "narrative");
  assert.deepEqual(a.diagnostics.get(uri), []);
});

test("blank-line whitespace does not select or violate an indentation style", () => {
  const source = "*if true\n\tFirst.\n \t \n\tSecond.\nOutside.";
  const context = engine();

  // printLoop skips blank lines before getIndent, regardless of their whitespace.
  assert.doesNotThrow(() =>
    vm.runInContext(
      `scene.lines = ${JSON.stringify(source.split("\n"))}; for (scene.lineNum = 0; scene.lineNum < scene.lines.length; scene.lineNum++) { const line = scene.lines[scene.lineNum]; if (line.trim()) scene.getIndent(line); }`,
      context,
    ),
  );
  assert.deepEqual(parseDocument(uri, source).diagnostics, []);
  assert(parseDocument(uri, "*if true\n\tOne.\n  Two.").diagnostics.some((d) => d.code === "mixed-indentation"));
});

test("unknown generated text stays neutral after either style of quote", () => {
  for (const source of ["${missing}", "@{true ${missing}|Other}", "*print missing"]) {
    const a = analyze(source + '\n“Hello.”\n"More."\nOutside.');

    assert(!a.diagnostics.get(uri)!.some((d) => d.code.startsWith("quote-")));
    assert(!a.tokens.get(uri)!.some((t) => t.type === "dialogue"));
  }
});

test("a missing static scene does not inject unknown state into unrelated scenes", () => {
  const next = "file:///corpus/scenes/next.txt";
  const a = analyzeProject([
    {
      uri,
      text: "*create score 1\n*if true\n  *goto_scene missing\n*else\n  *goto_scene next",
    },
    { uri: next, text: '*print score\n"Complete dialogue."' },
  ]);

  assert(a.diagnostics.get(uri)!.some((d) => d.code === "missing-target"));
  assert(a.tokens.get(next)!.some((t) => t.line === 0 && t.type === "numberVariable"));
  assert(a.tokens.get(next)!.some((t) => t.line === 1 && t.type === "dialogue"));
  assert.equal(a.truncated, false);
});

test("numeric and punctuated labels and scene names resolve as whole references", () => {
  const context = engine();
  const labels = ["*label 2first", "*label 2second", "*label finish-here"];

  assert.doesNotThrow(() =>
    vm.runInContext(`scene.lines = ${JSON.stringify(labels)}; scene.parseLabels(); scene.goto("2second")`, context),
  );
  assert.equal(vm.runInContext("scene.lineNum", context), 1);
  assert.equal(vm.runInContext('scene.parseGotoScene("3-next finish-here 3").sceneName', context), "3-next");

  const next = "file:///corpus/scenes/3-next.txt";
  const a = analyzeProject([
    {
      uri,
      text: '*create score 1\n"Hello\n*gosub 2first 3\n*goto_scene 3-next finish-here\n*label 2first\n*params amount\n*set score amount\n*return\n*label 2second\n*return',
    },
    { uri: next, text: '*label finish-here\nworld."\n*print score' },
  ]);

  assert.deepEqual([...a.diagnostics.values()].flat(), []);
  assert.equal(definition(a, uri, { line: 2, character: 10 })?.range.start.line, 4);
  assert.equal(definition(a, uri, { line: 3, character: 15 })?.uri, next);

  const edits = rename(a, uri, { line: 2, character: 10 }, "helper")!.changes[uri];

  assert.equal(edits.length, 2);
  assert(edits.every((e) => e.range.end.character - e.range.start.character === 6));
  assert(a.tokens.get(next)!.some((t) => t.line === 1 && t.type === "dialogue"));
  assert(a.tokens.get(next)!.some((t) => t.line === 2 && t.type === "numberVariable"));
});

test("variable snapshots preserve siblings when assigning, deleting, and merging", () => {
  const original = new Environment(new Map([["value", literal(1)]]));
  const first = original.clone(),
    second = original.clone();
  first.set("value", literal("text"));
  second.delete("value");

  assert.equal(original.get("value")?.constant, 1);
  assert.equal(first.get("value")?.constant, "text");
  assert.equal(second.has("value"), false);
  assert.equal(original.size, 1);
});

test("unequal choice branches converge before a long continuation within a bounded work budget", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `*create flag${i} false`);
  lines.push("*fake_choice");

  for (let i = 0; i < 40; i++) {
    lines.push(`  #Option ${i}`, `    *set flag${i} true`);
    for (let j = 0; j <= i * 5; j++) lines.push("    A quiet moment.");
  }

  for (let i = 0; i < 2000; i++) lines.push("Ordinary narrative.");

  lines.push("*print flag39");

  const a = analyzeProject([{ uri, text: lines.join("\n") }], {
    maxSteps: lines.length * 3,
  });

  assert.equal(a.truncated, false);
  assert.equal(token(a, lines.length - 1, 7), "booleanVariable");
  assert.deepEqual(a.diagnostics.get(uri), []);
});
