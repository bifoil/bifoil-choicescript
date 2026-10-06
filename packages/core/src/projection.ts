import type { Document, Line, NarrativeSummary, Range } from "./types.js";

/**
 * Apply one narrative character to every possible incoming quote state.
 * Bits: outside=1, straight-open=2, curly-open=4; unions represent disagreement,
 * and 7 is absorbing unknown. A continued paragraph's repeated opening straight
 * quote does not close inherited dialogue. Expression lexing must not call this.
 */
export function advanceQuote(mask: number, char: string, continuation = false): number {
  if (mask === 7) return 7;

  let next = 0;

  for (const bit of [1, 2, 4])
    if (mask & bit) {
      if (char === '"') next |= bit === 2 ? (continuation ? 2 : 1) : bit === 1 ? 2 : bit;
      else if (char === "“") next |= bit === 1 ? 4 : bit;
      else if (char === "”") next |= bit === 4 ? 1 : bit;
      else next |= bit;
    }

  return next;
}

function words(line: Line): number {
  if (line.kind !== "prose" && line.kind !== "option" && line.inlineText === undefined) return 0;

  return (
    line.raw
      .slice(line.inlineText ?? line.indent)
      .replace(/\[[^\]]*]/g, "")
      .match(/[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu) ?? []
  ).length;
}

/**
 * Precompute all quote/paragraph transfers before discarding the original prose; retain warning locations and counts.
 */
function summarize(lines: Line[]): NarrativeSummary {
  const result: NarrativeSummary = { quotes: [], paragraphs: [], unexpectedClose: [], disagreements: [] };
  const prose = lines.filter((line) => line.kind === "prose"),
    first = prose[0],
    last = prose.at(-1);

  if (last) result.lastProse = { line: last.line, indent: last.indent, length: last.raw.length - last.indent };

  if (!prose.some((line) => /["“”]/.test(line.raw))) {
    result.identity = {
      paragraph: lines.at(-1)?.kind === "blank",
      range:
        first && last
          ? {
              start: { line: first.line, character: first.indent },
              end: { line: last.line, character: last.raw.length },
            }
          : undefined,
    };
    return result;
  }

  for (let mask = 1; mask <= 7; mask++)
    for (const initialParagraph of [false, true]) {
      let quote = mask,
        paragraph = initialParagraph;
      let problem: { at: { line: number; character: number }; count: number } | undefined;
      let disagreement: Range | undefined;

      for (const line of lines) {
        if (line.kind === "blank") {
          paragraph = true;
          continue;
        }

        if (line.kind !== "prose") continue;

        result.lastProse = { line: line.line, indent: line.indent, length: line.raw.length - line.indent };

        if (quote !== 7 && (quote & (quote - 1)) !== 0) {
          disagreement ??= {
            start: { line: line.line, character: line.indent },
            end: { line: line.line, character: line.raw.length },
          };
          disagreement.end = { line: line.line, character: line.raw.length };
        }

        if (!/[“”"\[]/.test(line.raw)) {
          paragraph = false;
          continue;
        }

        let first = true;

        for (let i = line.indent; i < line.raw.length; i++) {
          const ch = line.raw[i];

          if (ch === "[") {
            const tag = /^\[[^\]]*]/.exec(line.raw.slice(i));

            if (tag) {
              i += tag[0].length - 1;
              continue;
            }
          }

          const mark = ch === '"' || ch === "“" || ch === "”";

          if (/\S/.test(ch) && !mark) first = false;

          if (ch === "”" && quote === 1) {
            problem ??= { at: { line: line.line, character: i }, count: 0 };
            problem.count++;
          }

          if (mark) {
            quote = advanceQuote(quote, ch, paragraph && first);
            first = false;
          }
        }

        paragraph = false;
      }

      result.quotes.push(quote);
      result.paragraphs.push(paragraph);
      result.unexpectedClose.push(problem);
      result.disagreements.push(disagreement);
    }

  return result;
}

/**
 * Destructively compact a full parsed document for closed-scene analysis.
 * Collapses eligible prose/blank runs, retaining transfer tables, original extents,
 * and word counts. Commands, substitutions, and control-flow structure stay explicit.
 *
 * Returns the same Document with empty text and sparse lines. Do not call twice on
 * an already projected document, or reuse it for full-source features without reparsing.
 */
export function projectDocument(document: Document): Document {
  const sourceLines = document.lines;
  document.lineCount = sourceLines.length;
  document.endCharacter = sourceLines.at(-1)?.raw.length ?? 0;

  const pure = (line: Line): boolean =>
    (line.kind === "blank" && line.children.every((child) => child.kind === "blank")) ||
    (line.kind === "prose" && !/[$@]/.test(line.raw) && line.children.every((child) => child.kind === "blank"));

  const flatten = (line: Line): Line[] => [line, ...line.children.flatMap(flatten)];

  function block(lines: Line[], parent?: Line): Line[] {
    const output: Line[] = [];

    for (let i = 0; i < lines.length; ) {
      const current = lines[i];

      if (pure(current)) {
        const run: Line[] = [];

        while (i < lines.length && pure(lines[i])) run.push(...flatten(lines[i++]));

        run.sort((a, b) => a.line - b.line);

        const summary = summarize(run),
          first = run.find((line) => line.kind === "prose") ?? run[0];
        const node: Line = {
          ...first,
          parent,
          children: [],
          tokens: [],
          raw: " ".repeat(first.indent) + (first.kind === "blank" ? "" : "X"),
          args: "",
          narrativeSummary: summary,
          wordCount: run.reduce((n, line) => n + words(line), 0),
          endLine: run.at(-1)!.line,
        };
        output.push(node);
      } else {
        current.parent = parent;
        current.wordCount = words(current);
        current.children = block(current.children, current);
        output.push(current);
        i++;
      }
    }

    return output;
  }

  document.roots = block(document.roots);

  const collect = (line: Line): Line[] => [line, ...line.children.flatMap(collect)];

  document.lines = document.roots.flatMap(collect).sort((a, b) => a.line - b.line);
  document.text = "";
  document.compact = true;

  return document;
}
