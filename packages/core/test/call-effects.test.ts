import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeProject } from "../src/index.js";

const startup = "file:///original/scenes/startup.txt";
const helper = "file:///original/scenes/helper.txt";

function classification(result: ReturnType<typeof analyzeProject>, uri: string, text: string, needle: string) {
  const lines = text.split("\n");
  const line = lines.indexOf(needle);
  assert(line >= 0);
  const column = lines[line].indexOf(" ") + 1;
  return result.tokens
    .get(uri)!
    .find((span) => span.line === line && span.start <= column && span.start + span.length > column)?.type;
}

test("repeated calls preserve unrelated caller assignments and summaries retain real writes", () => {
  const text =
    "*create outside 1\n*create count 0\n*gosub increment\n*set outside true\n*gosub increment\n*print outside\n*print count\n*ending\n*label increment\n*set count +1\n*return";
  const result = analyzeProject([{ uri: startup, text }]);
  assert.equal(result.truncated, false);
  assert.equal(classification(result, startup, text, "*print outside"), "booleanVariable");
  assert.equal(classification(result, startup, text, "*print count"), "numberVariable");
  assert.deepEqual(result.diagnostics.get(startup), []);
});

test("callee deletion reveals globals while scene calls restore the caller local frame", () => {
  const text =
    "*create value true\n*temp value 1\n*gosub remove\n*print value\n*temp value 2\n*gosub_scene helper change\n*print value + 0\n*ending\n*label remove\n*delete value\n*return";
  const result = analyzeProject([
    { uri: startup, text },
    { uri: helper, text: '*label change\n*temp value "other scene"\n*return' },
  ]);
  assert.equal(result.truncated, false);
  assert.equal(classification(result, startup, text, "*print value"), "booleanVariable");
  assert.equal(classification(result, startup, text, "*print value + 0"), "numberVariable");
});

test("array and parameter effects preserve unmodified elements and unrelated bindings", () => {
  const text =
    '*create_array items 2 1 "second"\n*create outside false\n*gosub replace 1\n*print items[1]\n*print items[2]\n*print outside\n*ending\n*label replace\n*params index\n*set items[index] true\n*return';
  const result = analyzeProject([{ uri: startup, text }]);
  assert.equal(result.truncated, false);
  assert.equal(classification(result, startup, text, "*print items[1]"), "booleanVariable");
  assert.equal(classification(result, startup, text, "*print items[2]"), "stringVariable");
  assert.equal(classification(result, startup, text, "*print outside"), "booleanVariable");
});

test("transitive recursive effects converge and preserve independent caller values", () => {
  const text =
    "*create implicit_control_flow true\n*create flag false\n*create count 0\n*create outside 1\n*gosub first\n*set outside true\n*gosub first\n*print outside\n*ending\n*label first\n*if flag\n  *gosub second\n*return\n*label second\n*set count +1\n*gosub first\n*return";
  const result = analyzeProject([{ uri: startup, text }]);
  assert.equal(result.truncated, false);
  assert.equal(classification(result, startup, text, "*print outside"), "booleanVariable");
});

test("indirect writes keep full-state analysis and resolve the known target", () => {
  const text =
    '*create target "value"\n*create value false\n*create outside true\n*gosub change\n*print value\n*print outside\n*ending\n*label change\n*setref target 5\n*return';
  const result = analyzeProject([{ uri: startup, text }]);
  assert.equal(result.truncated, false);
  assert.equal(classification(result, startup, text, "*print value"), "numberVariable");
  assert.equal(classification(result, startup, text, "*print outside"), "booleanVariable");
});
