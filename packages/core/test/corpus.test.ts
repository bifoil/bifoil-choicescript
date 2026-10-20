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

function token(a: ReturnType<typeof analyze>, line: number, character: number, source = uri) {
  return a.tokens.get(source)!.find((t) => t.line === line && t.start <= character && t.start + t.length > character)
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

test("comment-only conditional bodies are valid and retain sibling alternatives", () => {
  const source =
    "*create implicit_control_flow true\n*if true\n\n  *comment Deliberately empty.\n*else\n  *comment Also empty.\nFollowing prose.";
  const context = engine();
  vm.runInContext(
    `scene.loadLines(${JSON.stringify(source)}); scene.lineNum = 1; scene.indent = 0; scene["if"]("true")`,
    context,
  );
  assert.deepEqual(analyze(source).diagnostics.get(uri), []);
});

test("a UTF-8 BOM preserves physical ranges without changing indentation", () => {
  const source = "\uFEFF*if true\r\n One line.\r\n*else\r\n Another line.";
  const a = analyze(source);
  assert.deepEqual(a.diagnostics.get(uri), []);
  assert.equal(token(a, 0, 0), undefined);
  assert.equal(token(a, 0, 1), "keyword");
  assert.equal(token(a, 0, 5), "boolean");
  assert.equal(a.documents.get(uri)!.lines[1].parent?.line, 0);
});

test("Unicode whitespace-only lines do not break blocks or become prose parents", () => {
  const source = "*if true\n\u00a0 \u00a0\n  Still in the block.\n\t\u00a0\n  Another line.\nOutside.";
  const a = analyze(source);
  assert.deepEqual(a.diagnostics.get(uri), []);
  assert.equal(a.documents.get(uri)!.lines[1].kind, "blank");
  assert.equal(a.documents.get(uri)!.lines[4].parent?.line, 0);
});

test("jump targets can start a deeper region after an unconditional transfer", () => {
  const source = "*goto deeper\n    *label deeper\n    *temp count 1\n    *print count\n    *ending";
  const a = analyze(source);
  assert.deepEqual(a.diagnostics.get(uri), []);
  assert.equal(token(a, 3, 11), "numberVariable");
  assert.equal(definition(a, uri, { line: 0, character: 8 })?.range.start.line, 1);
});

test("bounded analysis does not publish certain types or quote warnings from unfinished flow", () => {
  const source = '*temp flag true\n*if flag\n  "Open\n*else\n  Ordinary.\n*print flag';
  const a = analyzeProject([{ uri, text: source }], { maxSteps: 2 });
  assert.equal(a.truncated, true);
  assert(!a.diagnostics.get(uri)!.some((d) => d.code.startsWith("quote-")));
  assert.equal(token(a, 5, 7), "variable");
});

test("incomplete command diagnostics stay on the physical line within its UTF-16 extent", () => {
  const lines = ["*comment 😀", "*set", "*set value", "*if", "  *set value +", "*create value (1 + 2)"];
  const d = parseDocument(uri, lines.join("\r\n"));
  assert(d.diagnostics.some((d) => d.code === "missing-value" && d.range.start.line === 4));
  assert(d.diagnostics.some((d) => d.code === "missing-expression" && d.range.start.line === 3));
  for (const diagnostic of d.diagnostics)
    for (const p of [diagnostic.range.start, diagnostic.range.end]) {
      assert(p.line >= 0 && p.line < lines.length);
      assert(p.character >= 0 && p.character <= lines[p.line].length, JSON.stringify(diagnostic));
    }
});

test("truncated flow cannot rename or navigate a guessed shadowed reference", () => {
  const text = '*create value 1\n*temp value "local"\n*print value';
  const a = analyzeProject([{ uri, text }], { maxSteps: 1 });
  assert.equal(rename(a, uri, { line: 0, character: 9 }, "replacement"), null);
  assert.equal(definition(a, uri, { line: 2, character: 8 }), null);
});

test("labels introduce reachable indentation regions even after unreachable prose", () => {
  const source = "*goto nested\nUnused prose.\n    *label nested\n    *temp count 1\n    *print count\n    *ending";
  const a = analyze(source);
  assert.deepEqual(a.diagnostics.get(uri), []);
  assert.equal(token(a, 4, 11), "numberVariable");
});

test("non-ASCII indentation is diagnosed locally while command parsing recovers", () => {
  const source = "\u00a0*if true\n  Inside.\n*print 42";
  const a = analyze(source);
  assert.equal(a.diagnostics.get(uri)!.filter((d) => d.code === "indentation-whitespace").length, 1);
  assert.equal(token(a, 0, 1), "keyword");
  assert.equal(token(a, 2, 7), "number");
});

test("comments alone do not provide an option for a choice block", () => {
  assert(
    parseDocument(uri, "*fake_choice\n  *comment No options yet.").diagnostics.some((d) => d.code === "missing-block"),
  );
});

test("syntax-only recovery keeps literal colors and local errors without guessed flow", () => {
  const text = '*temp flag true\n"Open dialogue\n*set flag "unterminated\n*print 42\nOutside.';
  const a = analyzeProject([{ uri, text }], { maxSteps: 0 });
  assert.equal(a.truncated, true);
  assert(a.diagnostics.get(uri)!.some((d) => d.code === "expression-string" && d.range.start.line === 2));
  assert(!a.diagnostics.get(uri)!.some((d) => d.code.startsWith("quote-")));
  assert.equal(token(a, 1, 1), "narrative");
  assert.equal(token(a, 3, 7), "number");
  assert.equal(token(a, 4, 1), "narrative");
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => analyzeProject([{ uri, text }], { maxSteps: 0, signal: controller.signal }), /cancelled/);
});

test("scene names preserve case while labels remain case-insensitive", () => {
  const context = engine();
  assert.equal(vm.runInContext('scene.parseGotoScene("Act ENTRY").sceneName', context), "Act");
  vm.runInContext('scene.stats.destination = "act"', context);
  assert.equal(vm.runInContext('scene.parseGotoScene("{destination} ENTRY").sceneName', context), "act");
  const upper = "file:///corpus/scenes/Act.txt",
    lower = "file:///corpus/scenes/act.txt";
  const text =
    '*create result 0\n*create destination "act"\n*gosub_scene Act ENTRY\n*print result\n*gosub_scene {destination} ENTRY\n*print result\n*ending';
  const a = analyzeProject([
    { uri, text },
    { uri: upper, text: "*label entry\n*set result 1\n*return" },
    { uri: lower, text: '*label entry\n*set result "text"\n*return' },
  ]);
  assert.deepEqual([...a.diagnostics.values()].flat(), []);
  assert.equal(a.symbols.get("scene:Act")?.uri, upper);
  assert.equal(a.symbols.get("scene:act")?.uri, lower);
  assert.equal(definition(a, uri, { line: 2, character: 14 })?.uri, upper);
  assert.equal(definition(a, uri, { line: 2, character: 19 })?.uri, upper);
  assert.equal(definition(a, uri, { line: 4, character: 28 })?.uri, lower);
  assert.equal(token(a, 3, 8), "numberVariable");
  assert.equal(token(a, 5, 8), "stringVariable");
});

test("blank scene-list rows do not interrupt case-preserving scene transitions", () => {
  const context = engine();
  const text = "*create value 7\n*scene_list\n\n  startup\n\n  Act\n*finish";
  vm.runInContext(`scene.loadLines(${JSON.stringify(text)});scene.lineNum=1;scene.indent=0`, context);
  assert.equal(vm.runInContext('scene.parseSceneList().join(",")', context), "startup,Act");
  const next = "file:///corpus/scenes/Act.txt";
  const a = analyzeProject([
    { uri, text },
    { uri: next, text: "*print value\n*ending" },
  ]);
  assert.deepEqual([...a.diagnostics.values()].flat(), []);
  assert.equal(token(a, 0, 8, next), "numberVariable");
  assert.equal(definition(a, uri, { line: 5, character: 3 })?.uri, next);
});
