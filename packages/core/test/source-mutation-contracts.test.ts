import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { test } from "node:test";
import { analyzeProject } from "../src/index.js";

const uri = "file:///original/scenes/startup.txt";
const originals = [
  '*create score 7\n*temp name "Ada"\nOriginal ${name}: ${score}.\n*ending',
  "*create_array items 3 1 2 3\n*temp i 2\n*set items[i] + 1\n*print items[i]\n*ending",
  '*create implicit_control_flow true\n*temp flag true\n*if flag\n  “First.”\n*else\n  "Second."\n*ending',
  "*temp score 5\n*choice\n  *if (score > 0) # First\n    *goto done\n  # Second\n    *goto done\n*label done\n*ending",
  "*create answer 0\n*gosub compute 2\n*print answer\n*ending\n*label compute\n*params amount\n*set answer amount + 1\n*return",
  "*temp value 2\n@{(value > 1) “Original 😀.”|Other ${value}.}\n[b]Original[/b]\n*ending",
  "*create score 50\n*set score %+ 10\n*set score %- 20\n*rand score 1 9\n*input_number score 1 10\n*print round(score / 2)\n*ending",
  '*temp prefix "items"\n*temp_array items 2 1 2\n*setref (prefix & "_1") 3\n*delete items_2\n*delete_array items\n*ending',
];

function verify(text: string) {
  const sources = [{ uri, text }];
  const native = analyzeProject(sources);
  const reference = analyzeProject(sources, { environment: "javascript" });
  assert.equal(native.truncated, false, text);
  assert.equal(reference.truncated, false, text);
  for (const key of ["tokens", "diagnostics", "references", "wordCounts"] as const)
    assert.deepEqual(native[key], reference[key], `${key}: ${text}`);
  const lines = text.split(/\r?\n/);
  for (const token of native.tokens.get(uri) ?? []) {
    assert(token.line >= 0 && token.line < lines.length, text);
    assert(token.start >= 0 && token.length > 0, text);
    assert(token.start + token.length <= lines[token.line].length, text);
  }
}

// The independent native arena and JavaScript environment must agree through
// incomplete edits as well as complete scenes. All fixtures are original.
test("bounded source edits preserve native/reference semantics and UTF-16 token bounds", { timeout: 30000 }, () => {
  for (const original of originals) {
    verify(original);
    const scalars = Array.from(original);
    for (let index = 0; index < scalars.length; index++)
      verify(scalars.slice(0, index).join("") + scalars.slice(index + 1).join(""));
    for (const match of original.matchAll(/\b(?:true|false|0|1)\b/g)) {
      for (const replacement of ["null", "true", "false", '"changed"', "1 + 2", "(1 > 2)"])
        verify(original.slice(0, match.index) + replacement + original.slice(match.index + match[0].length));
    }
  }
});

test("authored regression inputs retain native/reference agreement after value edits", { timeout: 30000 }, () => {
  const programs = new Set<string>();
  for (const name of readdirSync(new URL(".", import.meta.url)).sort()) {
    if (!name.endsWith(".test.ts") || name === "source-mutation-contracts.test.ts") continue;
    const source = ts.createSourceFile(
      name,
      readFileSync(new URL(name, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text.includes("\n") &&
        node.text.includes("*") &&
        node.text.length <= 4096
      )
        programs.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert(programs.size >= 25, "authored semantic regression corpus disappeared");
  let checked = 0;
  for (const original of [...programs].sort()) {
    verify(original);
    let mutations = 0;
    for (const match of original.matchAll(/\b(?:true|false|0|1)\b/g)) {
      for (const replacement of ["false", "7", '"changed"', "(1 > 2)"]) {
        verify(original.slice(0, match.index) + replacement + original.slice(match.index + match[0].length));
        checked++;
        mutations++;
      }
      if (mutations >= 24) break;
    }
  }
  assert(checked >= 100, "semantic edits must exercise more than intact controls");
});
