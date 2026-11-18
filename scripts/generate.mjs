/**
 * Generate the tracked VS Code TextMate fallback from shared command metadata.
 * Rules stop at physical line boundaries. Branch-dependent dialogue belongs to the
 * semantic analyzer; do not add a cross-line narrative string region here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

const commands = JSON.parse(await readFile("vendor/bifoil-language-server/core/commands.json", { encoding: "utf8" }));
const grammar = {
  name: "ChoiceScript",
  scopeName: "source.choicescript",
  patterns: [
    { name: "comment.line.choicescript", match: String.raw`(?i)^\s*\*comment\b.*$` },
    {
      begin: String.raw`(?i)^\s*(\*(?:` + Object.keys(commands).join("|") + String.raw`))\b`,
      end: "$",
      beginCaptures: { 1: { name: "keyword.control.choicescript" } },
      patterns: [
        {
          name: "string.quoted.double.choicescript",
          begin: '"',
          end: '"|$',
          patterns: [{ name: "constant.character.escape", match: String.raw`\\.` }],
        },
        { name: "constant.language.boolean", match: String.raw`\b(?:true|false)\b` },
        { name: "constant.numeric", match: String.raw`\b[0-9]+(?:\.[0-9]+)?\b` },
      ],
    },
    { name: "punctuation.definition.choice", match: String.raw`^\s*#` },
    { name: "punctuation.section.interpolation", match: String.raw`[$@]!{0,2}\{|\}` },
    { name: "punctuation.definition.tag", match: String.raw`\[/?[bi]\]` },
  ],
};
await mkdir("editors/vscode/syntaxes", { recursive: true });
await writeFile("editors/vscode/syntaxes/choicescript.tmLanguage.json", JSON.stringify(grammar, null, 2) + "\n");
