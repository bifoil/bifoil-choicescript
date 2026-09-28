import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { analyzeProject, parseDocument } from "@branchlight/core";

const uri = "file:///differential/scenes/startup.txt";
function engine() {
  const context = vm.createContext({ console });
  for (const name of ["scene", "util"])
    vm.runInContext(
      readFileSync(new URL(`../../../vendor/choicescript/web/${name}.js`, import.meta.url), "utf8"),
      context,
    );
  vm.runInContext(
    'scene = new Scene("startup", {score: 40, index: 2, items_1: 10, items_2: 20, matrix_1_2: 7, pointer: "score", name: "Alex", flag: true})',
    context,
  );
  return context;
}
test("expression combinations agree with the pinned interpreter", () => {
  const context = engine();
  for (const expression of [
    "items[index]",
    "matrix[1][2]",
    "{pointer}",
    '{"score"}',
    "(items[1] + items[2])",
    "(score %+ 20)",
    "(score %- 20)",
    '"Hi ${name}"',
    '"a\\\"b"',
    "(score > items[index])",
    "not(flag)",
    "length(name)",
    "items[1",
    "{pointer",
    '"bad',
    "(score + 1) +",
    "score + 1 * 2",
  ]) {
    let accepted = true;
    try {
      vm.runInContext(`scene.evaluateExpr(scene.tokenizeExpr(${JSON.stringify(expression)}))`, context);
    } catch {
      accepted = false;
    }
    const parsed = parseDocument(uri, "*print " + expression);
    assert.equal(!parsed.diagnostics.some((d) => d.severity === 1), accepted, expression);
  }
});
test("interpolation and multireplace match engine text retain expression token boundaries", () => {
  const context = engine();
  const cases = new Map([
    ["Hello ${name}.", "Hello Alex."],
    ["@{flag Yes|No}", "Yes"],
    ["@{index first|second|third}", "second"],
    ["${items[index]} and $!{name}", "20 and Alex"],
  ]);
  for (const [source, expected] of cases) {
    assert.equal(vm.runInContext(`scene.replaceVariables(${JSON.stringify(source)})`, context), expected);
    const parsed = parseDocument(uri, source);
    assert(!parsed.diagnostics.some((d) => d.severity === 1), source);
    assert(
      parsed.lines.flatMap((line) => line.tokens).some((t) => t.type === "interpolation"),
      source,
    );
  }
});
test("seeded conditional mutations retain local recovery and independent alternatives", () => {
  let seed = 123456;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 48; i++) {
    const indent = " ".repeat(2 + (random() % 3));
    const eol = random() % 2 ? "\r\n" : "\n";
    const quote = random() % 2 ? ["“", "”"] : ['"', '"'];
    const malformed = random() % 3 === 0;
    const lines = [
      "*create flag true",
      "*create implicit_control_flow true",
      quote[0] + "Hello",
      "*if flag",
      indent + "*temp name " + (malformed ? '"broken' : '"Alex"'),
      indent + "A." + quote[1],
      "*comment sibling",
      "*else",
      indent + "B." + quote[1],
      "Outside.",
    ];
    const result = analyzeProject([{ uri, text: lines.join(eol) }]);
    const tokens = result.tokens.get(uri)!;
    for (const line of [5, 8])
      assert(
        tokens.some((t) => t.line === line && t.type === "dialogue"),
        `seed case ${i}, line ${line}`,
      );
    assert(tokens.some((t) => t.line === 9 && t.type === "narrative"));
    const diagnostics = result.diagnostics.get(uri)!;
    assert.equal(diagnostics.filter((d) => d.code === "expression-string").length, malformed ? 1 : 0);
    assert(!diagnostics.some((d) => d.code.startsWith("quote-")));
  }
});
test("static parsing does not mistake runtime-only failures for syntax errors", () => {
  const context = engine();
  for (const expression of ["missing_variable", "items[99]"]) {
    assert.throws(() =>
      vm.runInContext(`scene.evaluateExpr(scene.tokenizeExpr(${JSON.stringify(expression)}))`, context),
    );
    assert(!parseDocument(uri, "*print " + expression).diagnostics.some((d) => d.code.startsWith("expression-")));
  }
});
