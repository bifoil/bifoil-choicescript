import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeProject, parseDocument, projectDocument } from "@bifoil/choicescript-core";

const uri = (scene: string) => "file:///game/scenes/" + scene + ".txt";

test("closed-scene summaries preserve types, dialogue transfers, references and word counts", () => {
  const startup =
    '*create implicit_control_flow true\n*create gender "male"\n*create value 7\n*scene_list\n  startup\n  chapter\n  ending\n*goto_scene chapter';
  const cases = [
    'She said "Hello,\n\n"still speaking,\n*if gender = "male"\n    William."\n*else\n    Belle."\n*set value "changed"\n*goto_scene ending',
    '“Hello,\n*if gender = "male"\n    *if value = 7\n        [b]still talking[/b]”\n    *else\n        welcome”\n*elseif value = 0\n    other”\n*else\n    final”\n*goto_scene ending',
    '*if gender = "male"\n    "open\n*set value true\n*goto_scene ending',
    '*label again\n"closed"\n*if value = 7\n    *set value 8\n    *goto again\n*goto_scene ending',
    'She said "Hello,\n*gosub close\n*goto_scene ending\n*label close\nWorld."\n*return',
    'She said "Hello,\n*set gender "broken\nWorld."\n*goto_scene ending',
    "Unicode Ω 😀 and apostrophe’s punctuation.\r\n*comment “ignored”\r\n*set value 7\r\n" +
      "$" +
      '{gender}\r\n@{gender "A"|"B"}\r\n*goto_scene ending',
  ];

  for (const chapter of cases) {
    const inputs = [
      { uri: uri("startup"), text: startup },
      { uri: uri("chapter"), text: chapter },
      { uri: uri("ending"), text: 'Afterwards.\n*if value = 7\n    "Hello."\n*else\n    Another day.\n*ending' },
    ];
    const full = analyzeProject(inputs);
    const compact = analyzeProject(
      inputs.map((d) => (d.uri === uri("ending") ? d : projectDocument(parseDocument(d.uri, d.text)))),
    );

    assert.equal(compact.truncated, false);
    assert.deepEqual(compact.tokens.get(uri("ending")), full.tokens.get(uri("ending")));
    assert.deepEqual(compact.symbols, full.symbols);
    assert.deepEqual(compact.references, full.references);
    assert.deepEqual(compact.values, full.values);
    assert.deepEqual(compact.wordCounts, full.wordCounts);
    assert.deepEqual(compact.diagnostics.get(uri("ending")), full.diagnostics.get(uri("ending")));

    for (const source of ["startup", "chapter"]) {
      const code = (full.tokens.get(uri(source)) ?? []).filter(
        (t) => !["dialogue", "narrative", "markup"].includes(t.type),
      );

      assert.deepEqual(
        (compact.tokens.get(uri(source)) ?? []).filter((t) => !["dialogue", "narrative", "markup"].includes(t.type)),
        code,
      );
    }
  }
});

test("summaries retain physical UTF-16 warning locations and collapse prose volume", () => {
  const text = "*create value 1\r\n" + "Ordinary words in a paragraph.\r\n".repeat(1000) + "”\r\n*ending";
  const full = analyzeProject([{ uri: uri("startup"), text }]);
  const doc = projectDocument(parseDocument(uri("startup"), text));

  assert(doc.lines.length < 10);
  assert.equal(doc.lineCount, 1003);

  const compact = analyzeProject([doc]);

  assert.deepEqual(compact.wordCounts, full.wordCounts);
  assert.deepEqual(compact.diagnostics, full.diagnostics);
});
