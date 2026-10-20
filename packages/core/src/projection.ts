import type { Document, Line, NarrativeSummary } from "./types.js";
import { narrativeWords } from "./plain-text.js";

/**
 * Apply one narrative character to every possible incoming quote state.
 * Bits: outside=1, straight-open=2, curly-open=4; unions represent disagreement,
 * and 7 is absorbing unknown. A continued paragraph's repeated opening straight
 * quote does not close inherited dialogue. Expression lexing must not call this.
 */
export function advanceQuote(mask: number, char: string, continuation = false): number {
  if (mask === 7) return 7;
  if (char === '\"') return (mask & 4) | (mask & 1 ? 2 : 0) | (mask & 2 ? (continuation ? 2 : 1) : 0);
  if (char === "“") return (mask & 6) | (mask & 1 ? 4 : 0);
  if (char === "”") return (mask & 3) | (mask & 4 ? 1 : 0);
  return mask;
}

function words(line: Line): number {
  if (line.kind !== "prose" && line.kind !== "option" && line.inlineText === undefined) return 0;

  return narrativeWords(line.raw.slice(line.inlineText ?? line.indent));
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
    for (const paragraph of [false, true]) {
      result.quotes.push(mask);
      result.paragraphs.push(paragraph);
      result.unexpectedClose.push(undefined);
      result.disagreements.push(undefined);
    }

  // Extract punctuation once, then apply its small transfer to all fourteen
  // incoming states. Narrative bytes and whitespace are never scanned fourteen times.
  for (const line of lines) {
    if (line.kind === "blank") {
      result.paragraphs.fill(true);
      continue;
    }
    if (line.kind !== "prose") continue;
    const marks: { char: string; column: number; first: boolean }[] = [];
    const pattern = /["“”\[]/g;
    pattern.lastIndex = line.indent;
    let first = true,
      previous = line.indent;
    let unclosedMarkup = false;
    for (let match = pattern.exec(line.raw); match; match = pattern.exec(line.raw)) {
      if (/\S/.test(line.raw.slice(previous, match.index))) first = false;
      if (match[0] === "[") {
        const close = unclosedMarkup ? -1 : line.raw.indexOf("]", match.index + 1);
        if (close >= 0) {
          pattern.lastIndex = close + 1;
          previous = close + 1;
          continue;
        }
        unclosedMarkup = true;
        first = false;
        previous = match.index + 1;
        continue;
      }
      marks.push({ char: match[0], column: match.index, first });
      first = false;
      previous = match.index + 1;
    }
    for (let row = 0; row < 14; row++) {
      let quote = result.quotes[row];
      if (quote !== 7 && (quote & (quote - 1)) !== 0) {
        let disagreement = result.disagreements[row];
        if (!disagreement)
          result.disagreements[row] = disagreement = {
            start: { line: line.line, character: line.indent },
            end: { line: line.line, character: line.raw.length },
          };
        disagreement.end.line = line.line;
        disagreement.end.character = line.raw.length;
      }
      for (const mark of marks) {
        if (mark.char === "”" && quote === 1) {
          const problem = (result.unexpectedClose[row] ??= {
            at: { line: line.line, character: mark.column },
            count: 0,
          });
          problem.count++;
        }
        quote = advanceQuote(quote, mark.char, result.paragraphs[row] && mark.first);
      }
      result.quotes[row] = quote;
      result.paragraphs[row] = false;
    }
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
