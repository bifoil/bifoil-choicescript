import { type Diagnostic, diagnostic, type Expr, literal, type Span, unknown, type Value } from "./types.js";

/**
 * One expression token with absolute UTF-16 source offsets; span is later annotated by parsing/analysis.
 */
export interface Lexeme {
  text: string;
  start: number;
  kind: string;
  span: Span;
}

/**
 * Tokenize one physical-line expression and append recoverable diagnostics.
 * `offset` locates the expression within that source line. Unterminated strings stop
 * at this input's end; no quote state is retained for another line or narrative text.
 */
export function lex(text: string, line: number, offset: number, diagnostics: Diagnostic[]): Lexeme[] {
  const result: Lexeme[] = [];

  for (let i = 0; i < text.length; ) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }

    const start = i;
    let kind = "operator";

    if (text[i] === '"') {
      i++;
      let closed = false;

      while (i < text.length) {
        if (text[i] === "\\") {
          i = Math.min(i + 2, text.length);
          continue;
        }

        if (text[i++] === '"') {
          closed = true;
          break;
        }
      }

      kind = "string";

      if (!closed)
        diagnostics.push(
          diagnostic(
            line,
            offset + start,
            i - start,
            "expression-string",
            "Expression string must close on this line.",
          ),
        );
    } else if (/[\u201c\u201d]/.test(text[i])) {
      i++;
      diagnostics.push(
        diagnostic(line, offset + start, 1, "expression-smart-quote", "Use straight double quotes in expressions."),
      );
    } else if (/\d/.test(text[i])) {
      const m = /^\d+(?:\.\d+)?\b/.exec(text.slice(i));
      i += m?.[0].length ?? 1;
      kind = "number";
    } else if (/[A-Za-z_]/.test(text[i])) {
      const m = /^\w+/.exec(text.slice(i))!;
      i += m[0].length;

      const word = m[0].toLowerCase();
      kind = /^(true|false)$/.test(word)
        ? "boolean"
        : /^(and|or|modulo)$/.test(word)
          ? "operator"
          : /^(not|round|timestamp|log|length|auto)$/.test(m[0]) && /^\s*\(/.test(text.slice(i))
            ? "function"
            : "variable";
    } else if (/^(%[+-]|[!<>]=)/.test(text.slice(i))) i += 2;
    else {
      i++;

      if (!/[()[\]{}+\-*/&%^#=<>!,]/.test(text[start]))
        diagnostics.push(
          diagnostic(
            line,
            offset + start,
            1,
            "expression-character",
            `Unexpected character ${text[start]} in expression.`,
          ),
        );
    }

    result.push({
      text: text.slice(start, i),
      start: offset + start,
      kind,
      span: { line, start: offset + start, length: i - start, type: kind },
    });
  }

  return result;
}

/**
 * Parse the pinned interpreter's grouped expression syntax, not JavaScript precedence.
 * Appends diagnostics and returns unknown nodes where recovery is needed.
 * `partial` permits trailing tokens; it does not suppress errors inside a consumed value.
 * The caller remains responsible for command-specific argument boundaries.
 */
export function parseExpression(tokens: Lexeme[], diagnostics: Diagnostic[], partial = false): Expr {
  let index = 0;

  const fail = (message: string, t = tokens[Math.min(index, tokens.length - 1)]) => {
    if (t) diagnostics.push(diagnostic(t.span.line, t.start, t.text.length, "expression-syntax", message));
  };

  function value(): Expr {
    const t = tokens[index++];

    if (!t) {
      fail("Expected a value.");
      return { kind: "unknown" };
    }

    if (t.kind === "number") return { kind: "literal", value: Number(t.text) };
    if (t.kind === "boolean") return { kind: "literal", value: t.text.toLowerCase() === "true" };

    if (t.kind === "string")
      return t.text.endsWith('"') && t.text.length > 1
        ? {
            kind: "literal",
            value: t.text.slice(1, -1).replace(/\\(.)/g, "$1"),
          }
        : { kind: "unknown" };

    if (t.text === "-") {
      fail("ChoiceScript does not accept unary minus here; write (0 - value).", t);
      value();
      return { kind: "unknown" };
    }

    if (t.text === "(" || t.text === "{") {
      const e = expression(t.text === "(" ? ")" : "}");
      return t.text === "{" ? { kind: "indirect", expr: e } : e;
    }

    if (t.kind === "function") {
      const name = t.text.toLowerCase();

      if (!["not", "round", "timestamp", "log", "length", "auto"].includes(name))
        fail("Unknown ChoiceScript function " + name + ".", t);

      if (tokens[index]?.text === "(") index++;

      const args: Expr[] = [];
      args.push(expression(")", true));

      while (tokens[index]?.text === ",") {
        index++;
        args.push(expression(")", true));
      }

      if (tokens[index]?.text === ")") index++;
      else fail("Expected closing parenthesis.");

      if (name !== "auto" && args.length !== 1) fail("This function accepts one expression.", t);

      return { kind: "call", name, args };
    }

    if (t.kind === "variable") {
      const indexes: Expr[] = [];

      while (tokens[index]?.text === "[") {
        index++;
        indexes.push(expression("]"));
      }

      return indexes.length
        ? { kind: "array", name: t.text.toLowerCase(), indexes, token: t.span }
        : { kind: "variable", name: t.text.toLowerCase(), token: t.span };
    }

    fail("Expected a value.", t);
    return { kind: "unknown" };
  }

  function expression(close?: string, stopComma = false): Expr {
    let left = value();
    const t = tokens[index];

    if (t && t.text !== close && (!stopComma || t.text !== ",")) {
      if (/^(\+|-|\*|\/|&|%[+-]|\^|#|=|!=|<=?|>=?|and|or|modulo)$/i.test(t.text)) {
        index++;
        left = {
          kind: "binary",
          op: t.text.toLowerCase(),
          left,
          right: value(),
        };
      } else fail("Expected an operator or closing delimiter.");
    }

    if (close && !stopComma) {
      if (tokens[index]?.text === close) index++;
      else fail(`Expected ${close}; use parentheses around compound expressions.`);
    }

    return left;
  }

  if (!tokens.length) return { kind: "unknown" };

  const e = expression();

  if (!partial && index < tokens.length)
    fail("Unexpected additional tokens; ChoiceScript requires parentheses around compound expressions.");

  return e;
}

/**
 * Infer types and selected constants without executing ChoiceScript or host code.
 * `lookup` receives normalized variable/generated-array names and supplies unknown
 * for unresolved bindings. Dynamic operations deliberately lose precision; an inferred
 * type is not validation that the runtime operation will succeed.
 */
export function evaluate(expr: Expr | undefined, lookup: (name: string) => Value): Value {
  if (!expr) return unknown();

  switch (expr.kind) {
    case "literal":
      return typeof expr.value === "string" && /[$@]!{0,2}\{/.test(expr.value)
        ? { types: ["string"] }
        : literal(expr.value);
    case "variable":
      return lookup(expr.name);
    case "array": {
      let name = expr.name;

      for (const e of expr.indexes) {
        const v = evaluate(e, lookup);

        if (v.constant === undefined) return lookup(name + "_*");

        name += "_" + v.constant;
      }

      return lookup(name);
    }
    case "indirect": {
      const v = evaluate(expr.expr, lookup);
      return typeof v.constant === "string" ? lookup(v.constant.toLowerCase()) : unknown();
    }
    case "call": {
      if (expr.name === "not") return { types: ["boolean"] };
      if (["round", "timestamp", "log", "length", "auto"].includes(expr.name)) return { types: ["number"] };

      return unknown();
    }
    case "binary": {
      const a = evaluate(expr.left, lookup),
        b = evaluate(expr.right, lookup),
        op = expr.op;

      if (op === "&")
        return a.constant !== undefined && b.constant !== undefined
          ? literal(String(a.constant) + String(b.constant))
          : { types: ["string"] };

      if (op === "#") return { types: ["string"] };
      if (["=", "!=", "<", ">", "<=", ">=", "and", "or"].includes(op)) return { types: ["boolean"] };

      if (
        a.constant !== undefined &&
        b.constant !== undefined &&
        typeof a.constant === "number" &&
        typeof b.constant === "number"
      ) {
        const x = a.constant,
          y = b.constant;
        const values: Record<string, number> = {
          "+": x + y,
          "-": x - y,
          "*": x * y,
          "/": x / y,
          "^": x ** y,
          modulo: x % y,
        };

        if (op in values && Number.isFinite(values[op])) return literal(values[op]);
      }

      return { types: ["number"] };
    }
    default:
      return unknown();
  }
}

/**
 * Partition tokens into argument values, retaining grouped expressions and array suffixes.
 * This is an argument-boundary helper, not a precedence parser or a validator.
 * Returned groups borrow the original tokens and spans.
 */
export function valueGroups(tokens: Lexeme[]): Lexeme[][] {
  const groups: Lexeme[][] = [];
  let i = 0;

  while (i < tokens.length) {
    const begin = i;
    const first = tokens[i++];

    const group = () => {
      const opens: Record<string, string> = { "(": ")", "{": "}", "[": "]" },
        stack: string[] = [];
      let pos = i - 1;

      for (; pos < tokens.length; pos++) {
        const t = tokens[pos].text;

        if (opens[t]) stack.push(opens[t]);
        else if (stack.at(-1) === t) stack.pop();

        if (!stack.length) break;
      }

      i = Math.min(tokens.length, pos + 1);
    };

    if (["(", "{", "["].includes(first.text)) group();
    else if (first.kind === "function" && tokens[i]?.text === "(") {
      i++;
      group();
    }

    while (tokens[i]?.text === "[") {
      i++;
      group();
    }

    groups.push(tokens.slice(begin, i));
  }

  return groups;
}

/**
 * Split the first count scene/label destinations from remaining value arguments.
 * Literal destinations are opaque words, including names beginning with digits.
 * Bracket/brace indirection switches to expression grouping, matching parseGotoScene.
 * All spans retain the original physical line and the supplied UTF-16 offset.
 */
export function referenceGroups(
  text: string,
  line: number,
  offset: number,
  diagnostics: Diagnostic[],
  count: number,
): Lexeme[][] {
  // Match parseGotoScene: indirect references switch the arguments to expressions.
  if (/[\[{]/.test(text)) return valueGroups(lex(text, line, offset, diagnostics));

  const groups: Lexeme[][] = [];
  let position = 0;

  for (let i = 0; i < count; i++) {
    const match = /^(\s*)(\S+)/.exec(text.slice(position));

    if (!match) break;

    position += match[1].length;

    const word = match[2],
      start = offset + position;
    groups.push([
      {
        text: word,
        start,
        kind: "reference",
        span: { line, start, length: word.length, type: "label" },
      },
    ]);
    position += word.length;
  }

  groups.push(...valueGroups(lex(text.slice(position), line, offset + position, diagnostics)));

  return groups;
}
