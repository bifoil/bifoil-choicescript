/**
 * Generate the tracked VS Code TextMate fallback from shared command metadata.
 * Rules stop at physical line boundaries. Branch-dependent dialogue belongs to the
 * semantic analyzer; do not add a cross-line narrative string region here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

const commands = JSON.parse(await readFile("packages/core/src/commands.json", { encoding: "utf8" }));
const grammar = {
  name: "ChoiceScript",
  scopeName: "source.choicescript",
  patterns: [
    { name: "comment.line.choicescript", match: "(?i)^\\s*\\*comment\\b.*$" },
    {
      begin: "(?i)^\\s*(\\*(?:" + Object.keys(commands).join("|") + "))\\b",
      end: "$",
      beginCaptures: { 1: { name: "keyword.control.choicescript" } },
      patterns: [
        {
          name: "string.quoted.double.choicescript",
          begin: '"',
          end: '"|$',
          patterns: [{ name: "constant.character.escape", match: "\\\\." }],
        },
        { name: "constant.language.boolean", match: "\\b(?:true|false)\\b" },
        { name: "constant.numeric", match: "\\b[0-9]+(?:\\.[0-9]+)?\\b" },
      ],
    },
    { name: "punctuation.definition.choice", match: "^\\s*#" },
    { name: "punctuation.section.interpolation", match: "[$@]!{0,2}\\{|\\}" },
    { name: "punctuation.definition.tag", match: "\\[/?[bi]\\]" },
  ],
};
await mkdir("editors/vscode/syntaxes", { recursive: true });
await writeFile("editors/vscode/syntaxes/choicescript.tmLanguage.json", JSON.stringify(grammar, null, 2) + "\n");
