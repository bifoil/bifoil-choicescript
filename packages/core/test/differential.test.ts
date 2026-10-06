import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { analyzeProject, evaluate, literal, parseDocument } from "@bifoil/choicescript-core";

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

test("assignment targets and setref shorthand agree with pinned interpreter commands", () => {
  const context = engine();
  vm.runInContext('scene.warning = function() {}; scene.stats.suffix = "ore";', context);

  for (const [command, args, type] of [
    ["set", "score (score + 1)", "number"],
    ["setref", "pointer -1", "number"],
    ["setref", "pointer +1", "number"],
    ["setref", '("score") 3', "number"],
    ["setref", '("sc" & suffix) *2', "number"],
    ["setref", '("score") &"!"', "string"],
    ["setref", "pointer %+20", "number"],
    ["setref", "pointer %-20", "number"],
  ]) {
    vm.runInContext("scene.stats.score = 40; scene.temps = {};", context);
    vm.runInContext("scene[" + JSON.stringify(command) + "](" + JSON.stringify(args) + ")", context);

    const expected = vm.runInContext('scene.getVar("score")', context);
    const a = analyzeProject([
      {
        uri,
        text:
          '*create score 40\n*create pointer "score"\n*create suffix "ore"\n*' +
          command +
          " " +
          args +
          "\n*print score",
      },
    ]);

    assert(!a.diagnostics.get(uri)!.some((d) => d.severity === 1), command + " " + args);
    assert.equal(
      a.tokens.get(uri)!.find((t) => t.line === 4 && t.start === 7)?.type,
      type + "Variable",
      command + " " + args + " => " + JSON.stringify(expected),
    );

    // The engine preserves bare NUMBER token text as strings; compare semantic values.
    const value = evaluate(a.documents.get(uri)!.lines[3].expr, (n) =>
      literal(n === "score" ? 40 : n === "pointer" ? "score" : "ore"),
    );

    if (value.constant !== undefined) assert.equal(String(value.constant), String(expected), command + " " + args);
  }

  for (const name of ["score", "round", "length", "not"]) {
    vm.runInContext("scene.temp(" + JSON.stringify(name + " (1 + 2)") + ")", context);

    assert.equal(vm.runInContext("scene.temps[" + JSON.stringify(name) + "]", context), 3);
    assert(!parseDocument(uri, "*temp " + name + " (1 + 2)").diagnostics.some((d) => d.severity === 1));

    if (name !== "score") {
      assert.throws(
        () => vm.runInContext("scene.set(" + JSON.stringify(name + " (" + name + " + 1)") + ")", context),
        /expected name, found FUNCTION/,
      );

      assert(
        parseDocument(uri, "*set " + name + " (" + name + " + 1)").diagnostics.some(
          (d) => d.code === "expression-reference",
        ),
      );
    }

    vm.runInContext("scene.set(" + JSON.stringify(name + " +1") + ")", context);

    assert.equal(vm.runInContext("scene.temps[" + JSON.stringify(name) + "]", context), 4);

    const analyzed = analyzeProject([
      { uri, text: "*temp " + name + " (1 + 2)\n*set " + name + " +1\n*print " + name },
    ]);

    assert.equal(
      analyzed.tokens.get(uri)!.find((token) => token.line === 2 && token.start === 7)?.type,
      "numberVariable",
    );

    assert.deepEqual(
      analyzed.diagnostics.get(uri)!.filter((d) => d.severity === 1),
      [],
    );
  }
});
