import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { analyzeProject, definition, encodeTokens, parseDocument, rename } from "@bifoil/choicescript-core";

const uri = "file:///game/scenes/startup.txt";
function analyze(text: string, other: Record<string, string> = {}) {
  return analyzeProject([
    { uri, text },
    ...Object.entries(other).map(([name, text]) => ({
      uri: `file:///game/scenes/${name}.txt`,
      text,
    })),
  ]);
}
const fixture =
  '*create gender "male"\n*create implicit_control_flow true\nShe said "This is the end,\n*if gender = "male"\n    William."\n*else\n    Belle."\nShe walked away.';
const at = (a: ReturnType<typeof analyze>, line: number, start: number) =>
  a.tokens.get(uri)!.find((t) => t.line === line && t.start <= start && t.start + t.length > start)?.type;
test("independent branches close the same narrative quote; command strings stay separate", () => {
  const a = analyze(fixture);
  assert.equal(at(a, 2, 10), "dialogue");
  assert.equal(at(a, 3, 15), "string");
  assert.equal(at(a, 4, 4), "dialogue");
  assert.equal(at(a, 6, 4), "dialogue");
  assert.equal(at(a, 7, 0), "narrative");
  assert.deepEqual(a.diagnostics.get(uri), []);
});
test("malformed expression ends at EOL without losing narrative state", () => {
  const a = analyze('*create name "x"\n"Hello\n*set name "broken\nworld."\nOutside');
  assert.equal(at(a, 3, 0), "dialogue");
  assert.equal(at(a, 4, 0), "narrative");
  assert.equal(a.diagnostics.get(uri)!.filter((d) => d.code === "expression-string").length, 1);
  assert(!a.diagnostics.get(uri)!.some((d) => d.code.startsWith("quote-")));
});
test("nested alternatives and elseif all inherit their own quote state", () => {
  const a = analyze(
    '*create x true\n"Hi\n*if x\n  *if x\n    A."\n  *else\n    B."\n*elseif x\n  C."\n*else\n  D."\nOutside',
  );
  for (const n of [4, 6, 8, 10]) assert.equal(at(a, n, n === 4 || n === 6 ? 4 : 2), "dialogue");
  assert.equal(at(a, 11, 0), "narrative");
});
test("missing else preserves the bypass path and produces conservative styling", () => {
  const a = analyze('*create x true\n"Hi\n*if x\n  A."\nMaybe');
  assert.equal(at(a, 4, 0), "narrative");
  assert(a.diagnostics.get(uri)!.some((d) => d.code === "quote-branch"));
});
test("quotes may open in every branch and close after the merge", () => {
  const a = analyze('*create x true\n*if x\n  "Hello\n*else\n  "Goodbye\nfriend."\nOutside');
  assert.equal(at(a, 5, 0), "dialogue");
  assert.equal(at(a, 6, 0), "narrative");
});
test("dialogue crosses scenes and returns from a subroutine", () => {
  const a = analyze('"Hello\n*gosub_scene helper\n*goto_scene next', {
    helper: "friend\n*return",
    next: 'again."\nOutside',
  });
  assert.equal(a.tokens.get("file:///game/scenes/helper.txt")![0].type, "dialogue");
  assert.equal(a.tokens.get("file:///game/scenes/next.txt")![0].type, "dialogue");
  assert(![...a.diagnostics.values()].flat().some((d) => d.code === "quote-unclosed"));
});
test("recursive subroutine analysis converges", () => {
  const a = analyze('*create x true\n"Hello\n*gosub rec\nworld."\n*ending\n*label rec\n*if x\n  *gosub rec\n*return');
  assert.equal(a.truncated, false);
  assert.equal(at(a, 3, 0), "dialogue");
});
test("continued dialogue paragraphs and curly quotes", () => {
  const a = analyze("“One paragraph.\n\n“Another paragraph.”\nOutside");
  assert.equal(at(a, 2, 0), "dialogue");
  assert.equal(at(a, 3, 0), "narrative");
  assert(!a.diagnostics.get(uri)!.some((d) => d.code.startsWith("quote-")));
});
test("flow-sensitive variable coloring and mixed types", () => {
  const a = analyze('*create x 1\n*create b true\n*print x\n*if b\n  *set x "text"\n*else\n  *set x 2\n*print x');
  assert.equal(at(a, 2, 7), "numberVariable");
  assert.equal(at(a, 7, 7), "variable");
});
test("rename edits only references and declarations, never matching prose", () => {
  const a = analyze("*create score 1\nscore is a word. ${score}\n*set score +1");
  const edit = rename(a, uri, { line: 2, character: 6 }, "points")!;
  assert.equal(edit.changes[uri].length, 3);
  assert(edit.changes[uri].every((e) => !(e.range.start.line === 1 && e.range.start.character === 0)));
  assert.equal(definition(a, uri, { line: 2, character: 6 })?.range.start.line, 0);
});
test("UTF-16 and CRLF tokens do not overlap", () => {
  const a = analyze('*create name "a"\r\n😀 "Hello ${name}."\r\n*print 3.14');
  const tokens = a.tokens.get(uri)!;
  assert.equal(at(a, 1, 3), "dialogue");
  for (let i = 1; i < tokens.length; i++)
    assert(tokens[i].line > tokens[i - 1].line || tokens[i].start >= tokens[i - 1].start + tokens[i - 1].length);
  assert.equal(encodeTokens(a, uri).data.length, tokens.length * 5);
});
test("incremental quote deletion and restoration do not retain stale state", () => {
  assert.equal(at(analyze(fixture), 7, 0), "narrative");
  const broken = analyze(fixture.replace('Belle."', "Belle."));
  assert.equal(at(broken, 7, 0), "narrative");
  assert(broken.diagnostics.get(uri)!.some((d) => d.code === "quote-branch"));
  assert.deepEqual(analyze(fixture).diagnostics.get(uri), []);
});
test("expression syntax follows official tokenizer for escapes and missing quotes", () => {
  const source = readFileSync(new URL("../../../vendor/choicescript/web/scene.js", import.meta.url), "utf8");
  const context = vm.createContext({ console });
  vm.runInContext(source, context);
  for (const expr of ['"hello"', '"escaped \\" quote"', '"unterminated']) {
    let accepted = true;
    try {
      vm.runInContext(`new Scene('startup').tokenizeExpr(${JSON.stringify(expr)})`, context);
    } catch {
      accepted = false;
    }
    const doc = parseDocument(uri, "*print " + expr);
    assert.equal(!doc.diagnostics.some((d) => d.code === "expression-string"), accepted, expr);
  }
});

test("arrays preserve indexed types and mutations", () => {
  const a = analyze(
    '*create_array items 2 10 "text"\n*print items[1]\n*print items[2]\n*set items[1] true\n*print items[1]',
  );
  assert.equal(at(a, 1, 7), "numberVariable");
  assert.equal(at(a, 2, 7), "stringVariable");
  assert.equal(at(a, 4, 7), "booleanVariable");
});
test("create permits only literal initializers and empty temp has unknown type", () => {
  for (const value of ["1 + 2", "(2)", "name", '"${name}"'])
    assert(
      analyze("*create x " + value)
        .diagnostics.get(uri)!
        .some((d) => d.code === "create-literal"),
    );
  const a = analyze("*temp x\n*print x");
  assert.equal(at(a, 1, 7), "variable");
});
test("shorthand subtraction is valid but unary minus in expressions is not", () => {
  assert(
    !analyze("*create x 10\n*set x -1")
      .diagnostics.get(uri)!
      .some((d) => d.code === "expression-syntax"),
  );
  assert(
    analyze("*print -1")
      .diagnostics.get(uri)!
      .some((d) => d.code === "expression-syntax"),
  );
});
test("differential expression syntax against the pinned interpreter", () => {
  const context = vm.createContext({ console });
  for (const name of ["scene", "util"])
    vm.runInContext(
      readFileSync(new URL("../../../vendor/choicescript/web/" + name + ".js", import.meta.url), "utf8"),
      context,
    );
  for (const expression of [
    "1",
    "1 + 2",
    "(1 + 2) * 3",
    "1 + 2 * 3",
    "-1",
    "(0 - 1)",
    "not(true)",
    "round(1.2)",
    'length("abc")',
    '"a" & "b"',
    "(true and false)",
    "1 <= 2",
    "1 % 2",
    "(1 + 2",
    '"unterminated',
  ]) {
    let accepted = true;
    try {
      vm.runInContext(
        `new Scene('startup').evaluateExpr(new Scene('startup').tokenizeExpr(${JSON.stringify(expression)}))`,
        context,
      );
    } catch {
      accepted = false;
    }
    const diagnostics = parseDocument(uri, "*print " + expression).diagnostics;
    assert.equal(!diagnostics.some((d) => d.severity === 1), accepted, expression);
  }
});

test("resolved indirect jumps carry dialogue and dynamic jumps remain neutral", () => {
  const a = analyze('*create dest "done"\n"Hello\n*goto {dest}\n*label done\nworld."\nOutside');
  assert.equal(at(a, 4, 0), "dialogue");
  const b = analyze('*temp dest\n*input_text dest\n"Hello\n*goto_scene {dest}', {
    next: 'Uncertain\n"More',
  });
  assert.equal(b.tokens.get("file:///game/scenes/next.txt")![0].type, "narrative");
  assert(![...b.diagnostics.values()].flat().some((d) => d.code.startsWith("quote-")));
});
test("local arrays retain scope, static aliases rename only the base, indirect assignments infer types", () => {
  const a = analyze(
    '*temp_array items 2 10 "text"\n*print items_1\n*print items[2]\n*temp pointer "items_1"\n*setref pointer true\n*print items_1',
  );
  assert.equal(at(a, 1, 7), "numberVariable");
  assert.equal(at(a, 2, 7), "stringVariable");
  assert.equal(at(a, 5, 7), "booleanVariable");
  const edit = rename(a, uri, { line: 1, character: 8 }, "values")!;
  assert.equal(edit.changes[uri].length, 4);
  assert(edit.changes[uri].every((e) => e.range.end.character - e.range.start.character === 5));
});
test("markup, multireplace, apostrophes, and interpolation use disjoint classifications", () => {
  const a = analyze("*create n 1\n[b]“It’s ${n} @{n one|two}.”[/b]");
  assert(!a.diagnostics.get(uri)!.some((d) => d.severity === 1));
  assert(a.tokens.get(uri)!.some((t) => t.type === "dialogue" && t.modifiers?.includes("bold")));
  assert(a.tokens.get(uri)!.some((t) => t.type === "interpolation"));
  assert(a.tokens.get(uri)!.some((t) => t.type === "numberVariable"));
});
test("malformed indentation and orphan alternatives recover locally", () => {
  const a = analyze("*else\n  Broken\n*print 42\n   bad indent\n*if true\n*print 1");
  for (const code of ["unexpected-indent", "orphan-alternative", "missing-block"])
    assert(a.diagnostics.get(uri)!.some((d) => d.code === code));
  assert.equal(at(a, 5, 7), "number");
});
test("large scene graphs converge and explicit cancellation works", () => {
  const scenes = Array.from({ length: 100 }, (_, i) => ({
    uri: `file:///game/scenes/${i ? "scene" + i : "startup"}.txt`,
    text:
      Array.from({ length: 60 }, () => "Ordinary narrative.").join("\n") +
      (i < 99 ? "\n*goto_scene scene" + (i + 1) : "\n*ending"),
  }));
  const result = analyzeProject(scenes);
  assert.equal(result.documents.size, 100);
  assert.equal(result.truncated, false);
  assert.equal(
    [...result.wordCounts.values()].reduce((a, b) => a + b, 0),
    12000,
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => analyzeProject(scenes, { signal: controller.signal }), /cancelled/);
});

test("an unknown array index invalidates the type of every possibly assigned element", () => {
  const a = analyze("*create_array scores 2 10\n*temp i\n*input_number i 1 2\n*set scores[i] true\n*print scores[1]");
  assert.equal(at(a, 4, 7), "variable");
});

test("scene-local variables shadow globals only after their declaration", () => {
  const a = analyze('*create score 1\n*print score\n*temp score "local"\n*print score');
  assert.equal(at(a, 1, 7), "numberVariable");
  assert.equal(at(a, 3, 7), "stringVariable");
  assert.equal(definition(a, uri, { line: 1, character: 8 })?.range.start.line, 0);
  assert.equal(definition(a, uri, { line: 3, character: 8 })?.range.start.line, 2);
});

test("reusable option directives own their indented bodies", () => {
  const a = analyze("*fake_choice\n  *hide_reuse #First\n    Text.\n  *disable_reuse #Second\n    Other.");
  assert(!a.diagnostics.get(uri)!.some((d) => d.severity === 1));
});

test("comments between sibling alternatives preserve independent inherited dialogue states", () => {
  const a = analyze(fixture.replace("*else", "*comment Alternative name\n*else"));
  assert.equal(at(a, 4, 4), "dialogue");
  assert.equal(at(a, 7, 4), "dialogue");
  assert.equal(at(a, 8, 0), "narrative");
  assert.deepEqual(a.diagnostics.get(uri), []);
});
