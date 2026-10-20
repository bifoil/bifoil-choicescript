import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeProject, parseDocument, projectDocument } from "@bifoil/choicescript-core";
import { narrativeWords, stripMarkup } from "../src/plain-text.js";

const uri = "file:///game/scenes/startup.txt";

test("word counts preserve markup adjacency, apostrophes, Unicode and unmatched markup", () => {
  assert.equal(stripMarkup("one[b]two[/b] [link nested]three [unfinished"), "onetwo three [unfinished");
  assert.equal(narrativeWords("one[b]two[/b] [link nested]three [unfinished"), 3);
  assert.equal(narrativeWords("Chinay’s café isn't empty. Ω 42 😀"), 6);
});

test("malformed markup on a long physical line does not consume subsequent commands", { timeout: 1000 }, () => {
  const start = performance.now();
  const text = "[".repeat(100_000) + "One Ω word\r\n*label after\r\n*ending";
  const full = analyzeProject([{ uri, text }]);
  const projected = analyzeProject([projectDocument(parseDocument(uri, text))]);
  assert.equal(full.wordCounts.get(uri), 3);
  assert.deepEqual(projected.wordCounts, full.wordCounts);
  assert.equal(full.truncated, false);
  assert(performance.now() - start < 1000);
  assert([...full.symbols.values()].some((symbol) => symbol.name === "after"));
});

test("command arguments and random-scene ranges preserve physical Unicode whitespace", () => {
  const doc = parseDocument(
    uri,
    "*comment comment\u2028text\n*goto_random_scene\n  *if (true) chapter  \n*label after",
  );
  assert.equal(doc.lines[0].args, "comment\u2028text");
  assert.equal(doc.lines[2].target, "chapter");
  const target = doc.lines[2].tokens.find((token) => token.type === "label");
  assert.equal(target?.start, 13);
  assert.equal(target?.length, 7);
  assert(doc.lines[2].tokens.some((token) => token.type === "boolean"));
});
