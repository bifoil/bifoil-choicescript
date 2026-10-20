import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeProject,
  evaluate,
  lex,
  literal,
  parseDocument,
  parseExpression,
  unknown,
  valueGroups,
  type Value,
} from "../src/index.js";
const uri = "file:///original/scenes/startup.txt";

test("expression inference preserves arithmetic constants and conservative function types", () => {
  const cases: [string, string, unknown][] = [
    ["1 + 2", "number", 3],
    ["7 - 2", "number", 5],
    ["3 * 4", "number", 12],
    ["7 / 2", "number", 3.5],
    ["2 ^ 3", "number", 8],
    ["7 modulo 3", "number", 1],
    ['"a" & "b"', "string", "ab"],
    ['"abc" # 1', "string", undefined],
    ["1 %+ 10", "number", undefined],
    ["1 %- 10", "number", undefined],
    ["1 / 0", "number", undefined],
    ["0 / 0", "number", undefined],
    ["1 = 2", "boolean", undefined],
    ["true and false", "boolean", undefined],
    ["true or false", "boolean", undefined],
    ["1 != 2", "boolean", undefined],
    ["1 <= 2", "boolean", undefined],
    ["2 >= 1", "boolean", undefined],
    ["1 < 2", "boolean", undefined],
    ["2 > 1", "boolean", undefined],
    ["round(2.5)", "number", undefined],
    ['length("abc")', "number", undefined],
    ["not(true)", "boolean", undefined],
    ["log(10)", "number", undefined],
    ["auto(1)", "number", undefined],
    ['timestamp("today")', "number", undefined],
    ['"${missing}"', "string", undefined],
  ];
  for (const [source, type, constant] of cases) {
    const diagnostics: Parameters<typeof lex>[3] = [];
    const expression = parseExpression(lex(source, 0, 0, diagnostics), diagnostics);
    assert.deepEqual(diagnostics, [], source);
    const value = evaluate(expression, () => unknown());
    assert.deepEqual(value.types, [type], source);
    assert.equal(value.constant, constant, source);
  }
});

test("indirect and nested array expressions resolve exact addresses and conservative dynamic families", () => {
  const bindings = new Map<string, Value>([
    ["address", literal("TaRgEt")],
    ["target", literal(true)],
    ["index", literal(2)],
    ["items_2_label", literal("selected")],
    ["items_*", { types: ["number", "string"] }],
  ]);
  const value = (text: string) => {
    const diagnostics: Parameters<typeof lex>[3] = [];
    return evaluate(
      parseExpression(lex(text, 0, 0, diagnostics), diagnostics),
      (name) => bindings.get(name) ?? unknown(),
    );
  };
  assert.equal(value("{address}").constant, true);
  assert.equal(value('items[index]["label"]').constant, "selected");
  assert.deepEqual(value("items[missing]").types, ["number", "string"]);
  assert.deepEqual(value("{missing}").types, ["unknown"]);
  assert.deepEqual(
    evaluate(undefined, () => literal(1)),
    unknown(),
  );
  const diagnostics: Parameters<typeof lex>[3] = [];
  const groups = valueGroups(lex('"hello" (1 + 2) items[index] {address}', 0, 0, diagnostics));
  assert.equal(groups.length, 4);
});

test("malformed expressions recover locally and preserve following commands and UTF-16 ranges", () => {
  const malformed = [
    '*set broken "unterminated',
    "*print “smart”",
    "*print (1 +)",
    "*print ((1 + 2)",
    "*print 1 + 2 + 3",
    "*set broken = 1",
    "*set broken +",
    "*print items[",
    "*print {",
    "*print round(",
    "*print !",
    "*if",
    "*else unexpected",
    "*",
    '*print "escaped \\" ${missing}"',
    "An unfinished ${value",
    "An unfinished @{value",
    "An empty ${}",
    "A malformed @{value}",
    "*if (true) # Original option",
    "*selectable_if (true) # Original selectable",
  ];
  for (const input of malformed) {
    const text = '*create keeper 1\r\n😀 "Before,\r\n' + input + '\r\nAfter."\r\n*print keeper';
    const doc = parseDocument(uri, text);
    assert.equal(doc.lines.at(-1)?.command, "print", input);
    const analysis = analyzeProject([{ uri, text }]);
    const physical = text.split(/\r?\n/);
    let lastLine = -1,
      lastEnd = 0;
    for (const token of analysis.tokens.get(uri)!) {
      assert(token.length > 0 && token.start + token.length <= physical[token.line].length, input);
      assert(token.line > lastLine || token.start >= lastEnd, input);
      lastLine = token.line;
      lastEnd = token.start + token.length;
    }
    assert(
      analysis.tokens.get(uri)!.some((token) => token.line === 4 && token.type === "keyword"),
      input,
    );
  }
});

test("flow graph handles fake choices, random destinations, and scoped call summaries", () => {
  const sources = [
    "*create implicit_control_flow true\n*create score 1\n*fake_choice\n  # First\n    *set score 2\n  # Second\n    *set score 3\n*print score\n*ending",
    "*create score 1\n*goto_random_scene\n  first\n  *if (score > 0) second\n*ending",
    "*create total 0\n*create_array items 2 1 2\n*gosub bump 1\n*gosub bump 2\n*print total\n*ending\n*label bump\n*params index\n*set items[index] +1\n*set total +1\n*return",
    '*create target "finish"\n*goto {target}\n*label finish\n*ending',
  ];
  for (const text of sources) {
    const result = analyzeProject([
      { uri, text },
      { uri: "file:///original/scenes/first.txt", text: "Original scene.\n*ending" },
      { uri: "file:///original/scenes/second.txt", text: "Original alternative.\n*ending" },
    ]);
    assert.equal(result.truncated, false);
    assert(result.tokens.get(uri)!.length > 0);
    assert(![...result.diagnostics.values()].flat().some((d) => d.code === "internal-error"));
  }
});

test("destination completion and rename reject prose and invalid identifiers", async () => {
  const { completions, rename, prepareRename } = await import("../src/index.js");
  const text =
    "*create score 1\n*label entry\n*goto en\n*gosub en\n*goto_scene he\n*gosub_scene he\n*redirect_scene he\nOriginal prose.\n*ending";
  const result = analyzeProject([
    { uri, text },
    { uri: "file:///original/scenes/helper.txt", text: "*ending" },
  ]);
  for (const line of [2, 3])
    assert(
      completions(result, uri, { line, character: text.split("\n")[line].length }).some(
        (item) => item.label === "entry",
      ),
    );
  for (const line of [4, 5, 6])
    assert(
      completions(result, uri, { line, character: text.split("\n")[line].length }).some(
        (item) => item.label === "helper",
      ),
    );
  assert.deepEqual(completions(result, uri, { line: 7, character: 6 }), []);
  assert.equal(prepareRename(result, uri, { line: 7, character: 2 }), null);
  assert.throws(() => rename(result, uri, { line: 0, character: 9 }, "bad-name"), /Names must start/);
});

test("unresolved writes and executable generated text produce neutral variable classifications", () => {
  for (const command of [
    "*set {destination} true",
    "*delete {destination}",
    "*setref destination true",
    "*script arbitraryOriginalCode()",
  ]) {
    const text =
      '*create score 1\n*temp destination ""\n*input_text destination\n' + command + "\n*print score\n*ending";
    const result = analyzeProject([{ uri, text }]);
    const score = result.tokens.get(uri)!.find((token) => token.line === 4 && token.symbol === "global:score");
    assert.equal(score?.type, "variable", command);
  }
});

test("native and JavaScript environments agree through opaque calls, arrays, and rendered alternatives", () => {
  const fixtures = [
    "*create_array items 2 1 2\n*gosub mutate\n*print items[1]\n*ending\n*label mutate\n*delete_array items\n*temp_array items 1 true\n*return",
    '*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*gosub_scene helper "123"\n*return',
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*gosub_scene helper true\n*return",
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*gosub_scene helper {missing}\n*return",
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*gotoref missing\n*return",
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*goto_scene missing\n*return",
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*gosub absent\n*return",
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*finish",
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*params a b c\n*set value param_3\n*return",
    "*create value 1\n*gosub outer 1 2 3\n*print value\n*ending\n*label outer\n*params a\n*set value param_3\n*return",
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*set {missing} true\n*return",
    "*create value 1\n*create_array items 2 true false\n*gosub outer\n*print value\n*ending\n*label outer\n*set items[missing] 1\n*set value items[1]\n*return",
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*temp value true\n*delete value\n*return",
    "*create value 1\n*goto_random_scene allow_no_selection\n  *if ((value > 0)) helper\n  *allow_reuse missing\n*print value\n*ending",
    '*create value 1\n*gotoref "finish"\n*label finish\n*print value\n*ending',
    "*create value 1\n*gosub outer\n*print value\n*ending\n*label outer\n*restart",
    "*create value 1\n*create value 2\n*label same\n*label same\n*print value\n*ending",
    '*temp choice false\n*temp value 1\nShe said "Before.\n*if choice\n  Outside.\n*else\n  Closed."\nAfter.\n*ending',
    "*temp value 2\nOriginal @{((value > 1)) [b]bold[/b]|[i]italic[/i]}.\n*ending",
    '*temp value 1\nOriginal @{value "open|closed"}.\n*ending',
    '*temp value "unknown"\nOriginal ${value} and @{value A|B}.\n*ending',
    "*temp value 1\n[b][i]Original ${value}[/i][/b]\n*ending",
    "*temp value 1\n*print value\nAn unmatched ” closing quote.\n*ending",
  ];
  for (const text of fixtures) {
    const sources = [
      { uri, text },
      {
        uri: "file:///original/scenes/helper.txt",
        text: '*label 123\n*set value true\n*return\n*label true\n*set value "changed"\n*return',
      },
    ];
    const native = analyzeProject(sources),
      javascript = analyzeProject(sources, { environment: "javascript" });
    assert.equal(native.truncated, false, text);
    assert.equal(javascript.truncated, false, text);
    assert.deepEqual(native.tokens, javascript.tokens, text);
    assert.deepEqual(native.diagnostics, javascript.diagnostics, text);
    assert.deepEqual(native.references, javascript.references, text);
    assert(
      native.tokens.get(uri)!.some((token) => token.type === "keyword"),
      text,
    );
  }
  assert.equal(analyzeProject([], { environment: "javascript" }).documents.size, 0);
});
