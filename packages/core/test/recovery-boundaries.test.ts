import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeProject,
  parseDocument,
  matching,
  evaluate,
  lex,
  parseExpression,
  unknown,
  definition,
  references,
  hover,
  completions,
  documentSymbols,
  folding,
  selections,
  encodeTokens,
  type Diagnostic,
} from "../src/index.js";
const uri = "file:///original/scenes/startup.txt";

function analyzed(text: string, helper = "*label begin\n*return") {
  return analyzeProject([
    { uri, text },
    { uri: "file:///original/scenes/helper.txt", text: helper },
  ]);
}

test("command recovery retains narrative boundaries after malformed destinations and nested targets", () => {
  const cases = [
    "*print 123abc",
    "*goto",
    "*gosub_scene",
    "*goto_scene",
    "*redirect_scene",
    "*setref",
    '*setref "score" % 2',
    "*set {{target}} 3",
    "*set items[items[1]] 4",
    '*setref ("score" & "") + 1',
    '*gosub_scene helper "escaped \\\" label" 2',
    "*return ignored",
    "*finish ignored",
    "*ending ignored",
    "*disable_reuse # Original option",
    "*allow_reuse # Original option",
    "*hide_reuse # Original option",
    "@{score one}",
    "${items[}",
    "[b]${round(}[/b]",
    "*scene_list\n  $premium helper",
    "*stat_chart\n  percent score\n  opposed_pair score\n    Left\n    Right\n  text title",
    "*goto_random_scene\n  helper\n  *if (score > 0) helper",
    "*choice\n  *comment Original comment",
    "*if true\n  *comment Original comment\n*else\n  *comment Other comment",
  ];
  for (const input of cases) {
    const source = '*create score 5\n*create title "Original"\n' + input + "\nRecovered narrative.\n*ending";
    const doc = parseDocument(uri, source);
    assert.equal(doc.lines.at(-1)?.command, "ending", input);
    assert(
      doc.lines.some((line) => line.raw === "Recovered narrative." && line.kind === "prose"),
      input,
    );
    const result = analyzed(source);
    assert.equal(result.truncated, false, input);
    for (const [file, diagnostics] of result.diagnostics) {
      const physical = result.documents.get(file)!.lines;
      for (const diagnostic of diagnostics) {
        const { start, end } = diagnostic.range;
        assert(start.line >= 0 && end.line < physical.length, input);
        assert(start.character >= 0 && end.character >= 0, input);
      }
    }
  }
  const nested = "{outer {inner} suffix}";
  assert.equal(matching(nested, 0), nested.length - 1);
  assert.equal(matching("(missing", 0), -1);
});

test("interprocedural array and parameter effects preserve caller globals without losing local scopes", () => {
  const sources = [
    "*create score 1\n*create_array values 2 1 2\n*gosub mutate 2\n*print values[2]\n*ending\n*label mutate\n*params index\n*set values[index] + 1\n*temp_array local 2 3 4\n*delete_array local\n*return",
    "*create score 1\n*gosub mutate 1 2 3\n*print score\n*ending\n*label mutate\n*params first\n*set score param_3\n*return",
    "*create score 1\n*gosub_scene helper begin 2\n*print score\n*ending",
    '*create score 1\n*create destination "helper"\n*gosub_scene {destination} begin 2\n*print score\n*ending',
    "*create score 1\n*create_array values 1001\n*gosub mutate\n*print score\n*ending\n*label mutate\n*delete_array values\n*rand score 1 2\n*return",
    "*create score 1\n*gosub mutate\n*ending\n*label mutate\n*temp value 2\n*delete value\n*input_number score 1 9\n*return",
  ];
  for (const text of sources) {
    const result = analyzed(text, "*label begin\n*params amount\n*set score + amount\n*return");
    assert.equal(result.truncated, false);
    assert([...result.symbols.values()].some((symbol) => symbol.name === "score" && symbol.kind === "global"));
    assert(![...result.diagnostics.values()].flat().some((diagnostic) => diagnostic.code === "internal-error"));
    assert(result.tokens.get(uri)!.some((token) => token.type === "numberVariable"));
  }
});

test("feature queries distinguish absent documents and prose from resolved source references", () => {
  const text = "*create score 1\n*print score\nOriginal prose.\n*ending";
  const result = analyzed(text);
  const missing = "file:///original/missing.txt";
  for (const location of [
    { line: -1, character: 0 },
    { line: 999, character: 999 },
    { line: 2, character: 3 },
  ]) {
    assert.equal(definition(result, uri, location), null);
    assert.deepEqual(references(result, uri, location, false), []);
    assert.equal(hover(result, uri, location), null);
  }
  assert.deepEqual(completions(result, missing, { line: 0, character: 0 }), []);
  assert.deepEqual(documentSymbols(result, missing), []);
  assert.deepEqual(folding(result, missing), []);
  assert.deepEqual(encodeTokens(result, missing), { data: [] });
  assert.equal(selections(result, missing, [{ line: 0, character: 0 }]).length, 1);
  const refs = references(result, uri, { line: 1, character: 8 }, false);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].range.start.line, 1);
});

test("unknown expression values cannot fabricate constants through concatenation or arithmetic", () => {
  for (const source of [
    'missing & "x"',
    '"x" & missing',
    "missing + 1",
    "1 + missing",
    '"x" + 1',
    '1 + "x"',
    "missing(1)",
  ]) {
    const diagnostics: Diagnostic[] = [];
    const expression = parseExpression(lex(source, 0, 0, diagnostics), diagnostics);
    const inferred = evaluate(expression, () => unknown());
    assert.equal(inferred.constant, undefined, source);
  }
});
