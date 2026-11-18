import commands from "../../../vendor/bifoil-language-server/core/commands.json" with { type: "json" };
import { diagnostic, type Document, type Expr, type Line, sceneName } from "./types.js";
import { validVariableName } from "./names.js";
import { lex, type Lexeme, parseExpression, referenceGroups, valueGroups } from "./expression.js";
import { mapStringDiagnostic } from "./string-diagnostics.js";

/**
 * Shared command help and fallback-generation input; recognition here does not imply full semantic validation.
 */
export const commandDocs: Record<string, string> = commands;
const blocks = new Set([
  "if",
  "elseif",
  "elsif",
  "else",
  "choice",
  "fake_choice",
  "scene_list",
  "stat_chart",
  "achievement",
  "goto_random_scene",
]);
const metadata = new Set(["scene_list", "stat_chart", "achievement", "goto_random_scene"]);
const expressions = new Set(["if", "elseif", "elsif", "selectable_if", "print", "looplimit"]);
const declaration = new Set(["create", "temp", "create_array", "temp_array"]);

function addStringTokens(doc: Document, node: Line, token: Lexeme): void {
  // Runtime STRING evaluation unescapes before expanding substitutions.
  // Preserve a map back to the original UTF-16 columns for rename and tokens.
  const raw = token.text;
  const limit = raw.endsWith('"') && raw.length > 1 ? raw.length - 1 : raw.length;
  let decoded = "";
  const offsets: number[] = [];

  for (let i = 1; i < limit; i++) {
    offsets.push(token.start + i);
    if (raw[i] === "\\" && i + 1 < limit) i++;

    decoded += raw[i];
  }

  offsets.push(token.start + limit);

  const inner: Line = { ...node, raw: decoded, tokens: [] };
  const nested: Document = { ...doc, diagnostics: [] };
  narrative(nested, inner, 0);

  for (const span of inner.tokens) {
    const start = offsets[span.start],
      end = offsets[span.start + span.length];
    node.tokens.push({ ...span, start, length: end - start });
  }

  for (const diagnostic of nested.diagnostics) {
    mapStringDiagnostic(diagnostic, offsets);
    doc.diagnostics.push(diagnostic);
  }
}

function addTokens(doc: Document, node: Line, tokens: Lexeme[]) {
  for (const token of tokens) {
    if (token.kind === "string") addStringTokens(doc, node, token);
    node.tokens.push(token.span);
  }
}

function addExpression(doc: Document, node: Line, text: string, start: number, partial = false): Expr {
  const tokens = lex(text, node.line, start, doc.diagnostics);
  addTokens(doc, node, tokens);
  return parseExpression(tokens, doc.diagnostics, partial);
}

/**
 * Find the closing brace paired with text[start] by balancing raw braces, like the interpreter.
 * Returns -1 if incomplete. The caller supplies the opening brace position and limits
 * its search to the appropriate physical-line narrative slice.
 */
export function matching(text: string, start: number): number {
  // The interpreter balances raw braces before evaluating the expression or
  // replacement alternatives. Quotes in alternatives are narrative punctuation.
  let depth = 1;

  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && !--depth) return i;
  }

  return -1;
}

/**
 * Annotate substitutions and markup within a source-line slice, appending tokens/diagnostics.
 * This identifies embedded code only: narrative quote state belongs to control-flow
 * analysis, not the parser. start/end are UTF-16 offsets, with end exclusive.
 */
export function narrative(doc: Document, node: Line, start: number, end = node.raw.length): void {
  const text = node.raw;
  for (let i = start; i < end; ) {
    const substitution = text[i] === "$" || text[i] === "@" ? /^([$@])(!{0,2})\{/.exec(text.slice(i)) : null;
    if (substitution) {
      i = addSubstitution(doc, node, i, end, substitution);
      continue;
    }
    const tag = text[i] === "[" ? /^\[\/?(?:b|i|u|s|url|n|c)(?:=[^\]]*)?\/?]/i.exec(text.slice(i)) : null;
    if (tag) {
      node.tokens.push({ line: node.line, start: i, length: tag[0].length, type: "markup" });
      i += tag[0].length;
      continue;
    }
    i++;
  }
}

function addSubstitution(doc: Document, node: Line, start: number, end: number, substitution: RegExpExecArray): number {
  const open = start + substitution[0].length - 1;
  const close = matching(node.raw, open);
  if (close < 0 || close >= end) {
    doc.diagnostics.push(
      diagnostic(node.line, start, end - start, "interpolation-close", "Substitution must close on this line."),
    );
    node.tokens.push({ line: node.line, start, length: end - start, type: "interpolation" });
    return end;
  }
  node.tokens.push(
    { line: node.line, start, length: substitution[0].length, type: "interpolation" },
    { line: node.line, start: close, length: 1, type: "interpolation" },
  );
  const body = node.raw.slice(open + 1, close);
  if (substitution[1] === "$") addExpression(doc, node, body, open + 1);
  else addMultireplace(doc, node, body, start, open, close);
  return close + 1;
}

function multireplaceSplit(body: string): number {
  let depth = 0;
  for (let k = 0; k < body.length; k++) {
    if (body[k] === "(") depth++;
    if (body[k] === ")") depth--;
    if (/\s/.test(body[k]) && depth === 0 && k > 0) return k;
  }
  return -1;
}

function addMultireplace(doc: Document, node: Line, body: string, start: number, open: number, close: number): void {
  const split = multireplaceSplit(body);
  if (split < 0) {
    doc.diagnostics.push(
      diagnostic(
        node.line,
        start,
        close - start + 1,
        "multireplace-options",
        "Multireplace requires an expression and alternatives separated by |.",
      ),
    );
    return;
  }
  addExpression(doc, node, body.slice(0, split), open + 1);
  const options = body.slice(split + 1);
  if (!options.includes("|"))
    doc.diagnostics.push(
      diagnostic(node.line, start, close - start + 1, "multireplace-options", "Provide at least two alternatives."),
    );
  let pos = open + split + 2;
  for (const part of options.split("|")) {
    narrative(doc, node, pos, pos + part.length);
    pos += part.length + 1;
  }
}

function balancedTargetEnd(tokens: Lexeme[], start: number, open: string, close: string): number {
  let depth = 1;
  let end = start + 1;
  while (end < tokens.length && depth) {
    if (tokens[end].text === open) depth++;
    if (tokens[end].text === close) depth--;
    end++;
  }
  return end;
}

function targetEnd(command: string, tokens: Lexeme[]): number {
  if (command === "setref") return valueGroups(tokens)[0]?.length ?? 0;
  if (tokens[0]?.text === "{") return balancedTargetEnd(tokens, 0, "{", "}");
  let end = 1;
  while (tokens[end]?.text === "[") end = balancedTargetEnd(tokens, end, "[", "]");
  return end;
}

function validateCreateLiteral(doc: Document, node: Line, rest: Lexeme[]): void {
  const c = node.command!;
  if (
    c === "create" &&
    rest.length &&
    (rest.length !== 1 ||
      !["number", "boolean", "string"].includes(rest[0].kind) ||
      (rest[0].kind === "string" && /[$@]!{0,2}\{/.test(rest[0].text)))
  )
    doc.diagnostics.push(
      diagnostic(
        node.line,
        rest[0].start,
        node.raw.length - rest[0].start,
        "create-literal",
        "*create requires a simple number, boolean, or string literal.",
      ),
    );
}

function assignmentValue(doc: Document, node: Line, rest: Lexeme[]): void {
  const c = node.command!;

  if (
    (c === "set" || c === "setref") &&
    rest[0] &&
    /^(?:[+\-*/&^#%]|%[+-]|and|or|modulo)$/.test(rest[0].text) &&
    node.targetExpr
  )
    node.expr = {
      kind: "binary",
      op: rest[0].text === "%" ? "modulo" : rest[0].text,
      left: c === "setref" ? { kind: "indirect", expr: node.targetExpr } : node.targetExpr,
      right: parseExpression(rest.slice(1), doc.diagnostics),
    };
  else if (!c.endsWith("_array") && !["rand", "input_text", "input_number", "delete", "delete_array"].includes(c))
    node.expr = rest.length ? parseExpression(rest, doc.diagnostics) : { kind: "unknown" };

  validateCreateLiteral(doc, node, rest);
  validateAssignmentValue(doc, node, rest);
}

function validateAssignmentValue(doc: Document, node: Line, rest: Lexeme[]): void {
  const c = node.command!;
  if ((c === "create" || c === "set" || c === "setref") && !rest.length)
    doc.diagnostics.push(
      diagnostic(node.line, node.argStart + node.args.length, 0, "missing-value", "Expected a value."),
    );

  if (node.expr?.kind === "binary" && node.expr.right.kind === "unknown" && rest.length === 1)
    doc.diagnostics.push(
      diagnostic(node.line, node.raw.length, 0, "missing-value", "Expected a value after the operator."),
    );
}

function targetCommand(doc: Document, node: Line): void {
  const c = node.command!,
    a = node.args,
    s = node.argStart;
  const ts = lex(a, node.line, s, doc.diagnostics);

  // Declarations consume a plain name before tokenizing their initializer as a value.
  // Builtin function names are legal declaration names in the pinned interpreter.
  if (declaration.has(c) && ts[0] && /^\w+$/.test(ts[0].text)) {
    ts[0].kind = "variable";
    ts[0].span.type = "variable";
  }

  if (c !== "setref" && ts[0]?.kind === "function")
    doc.diagnostics.push(
      diagnostic(
        node.line,
        ts[0].span.start,
        ts[0].span.length,
        "expression-reference",
        "Expected a variable reference before the value expression.",
      ),
    );

  const end = targetEnd(c, ts);

  addTokens(doc, node, ts);

  if (ts[0]) {
    node.targetExpr = parseExpression(ts.slice(0, end), c === "setref" ? doc.diagnostics : [], c !== "setref");
    node.target = ts
      .slice(0, end)
      .map((t) => t.text)
      .join("")
      .toLowerCase();
    node.targetToken = ts[0].span;
    if (declaration.has(c)) node.targetToken.modifiers = ["declaration"];
  }

  if (!ts[0]) doc.diagnostics.push(diagnostic(node.line, s, 0, "missing-variable", "Expected a variable name."));

  if (declaration.has(c) && ts[0] && !validVariableName(ts[0].text))
    doc.diagnostics.push(
      diagnostic(
        node.line,
        s,
        ts[0].text.length,
        "variable-name",
        "Use a nonreserved variable name starting with a letter.",
      ),
    );

  const rest = ts.slice(end);
  assignmentValue(doc, node, rest);

  if (c.endsWith("_array")) {
    node.expressions = valueGroups(rest).map((t) => parseExpression(t, doc.diagnostics));
    node.expr = node.expressions[1];
  }
}

function inlineOption(text: string): number {
  let quoted = false,
    depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && quoted) {
      i++;
      continue;
    }
    if (text[i] === '"') quoted = !quoted;
    if (quoted) continue;
    if (text[i] === "(") depth++;
    if (text[i] === ")") depth--;
    if (isOptionMarker(text, i, depth)) return i;
  }
  return -1;
}

function isOptionMarker(text: string, index: number, depth: number): boolean {
  return text[index] === "#" && depth === 0 && (index === 0 || /\s/.test(text[index - 1]));
}

function expressionCommand(doc: Document, node: Line): void {
  const c = node.command!,
    a = node.args,
    s = node.argStart;
  let expr = a;
  const option = ["if", "selectable_if"].includes(c) ? inlineOption(a) : -1;
  if (option >= 0) {
    expr = a.slice(0, option);
    node.inlineText = s + option + 1;
    narrative(doc, node, node.inlineText);
  }
  node.expr = addExpression(doc, node, expr, s);
  if (!expr.trim()) doc.diagnostics.push(diagnostic(node.line, s, 0, "missing-expression", "Expected an expression."));
}

function jumpCommand(doc: Document, node: Line): void {
  const c = node.command!,
    a = node.args,
    s = node.argStart;
  const count = c.endsWith("_scene") ? 2 : 1;
  const groups =
    c === "gotoref"
      ? valueGroups(lex(a, node.line, s, doc.diagnostics))
      : referenceGroups(a, node.line, s, doc.diagnostics, count);
  const ts = groups.flat();
  node.tokens.push(...ts.map((t) => t.span));
  for (const group of c === "gotoref" ? [] : groups.slice(0, count))
    if (group.length === 1 && group[0].kind === "variable") group[0].span.type = "label";

  if (ts[0]) {
    node.targetExpr =
      ts[0].kind === "reference" ? { kind: "literal", value: ts[0].text } : parseExpression(groups[0], [], true);
    node.target = c.endsWith("_scene") ? ts[0].text : ts[0].text.toLowerCase();
    node.targetToken = ts[0].span;
    if (c === "label") node.targetToken.modifiers = ["declaration"];
  }
}

function command(doc: Document, node: Line): void {
  const c = node.command!,
    a = node.args,
    s = node.argStart;

  if (!Object.hasOwn(commandDocs, c) && !["selectable_if"].includes(c))
    doc.diagnostics.push(
      diagnostic(node.line, node.indent, c.length + 1, "unknown-command", `Unknown ChoiceScript command *${c}.`),
    );

  if (["hide_reuse", "disable_reuse", "allow_reuse"].includes(c)) {
    const option = a.indexOf("#");

    if (option >= 0) {
      node.inlineText = s + option + 1;
      narrative(doc, node, node.inlineText);
    }

    return;
  }

  if (c === "comment") {
    node.tokens = [
      {
        line: node.line,
        start: node.indent,
        length: node.raw.length - node.indent,
        type: "comment",
      },
    ];
    return;
  }

  commandArguments(doc, node);
}

function commandArguments(doc: Document, node: Line): void {
  const c = node.command!,
    a = node.args,
    s = node.argStart;
  if (
    declaration.has(c) ||
    ["set", "setref", "delete", "delete_array", "rand", "input_text", "input_number"].includes(c)
  ) {
    targetCommand(doc, node);
  } else if (expressions.has(c)) {
    expressionCommand(doc, node);
  } else if (["label", "goto", "gosub", "goto_scene", "gosub_scene", "redirect_scene", "gotoref"].includes(c)) {
    jumpCommand(doc, node);
  } else if (c === "params") {
    const ts = lex(a, node.line, s, doc.diagnostics);
    node.tokens.push(...ts.map((t) => ({ ...t.span, modifiers: ["declaration"] })));
  } else if (["else", "return", "finish", "ending"].includes(c) && a.trim()) {
    if (c === "else")
      doc.diagnostics.push(diagnostic(node.line, s, a.length, "unexpected-argument", "Nothing may follow *else."));
  } else if (c === "script") {
    /* JavaScript is opaque to the ChoiceScript analyzer. */
  } else if (!blocks.has(c)) narrative(doc, node, s);
}

function lineKind(body: string): Line["kind"] {
  if (!body) return "blank";
  if (/^\*(\w+)/.exec(body)?.[1].toLowerCase() === "comment") return "comment";
  if (body.startsWith("*")) return "command";
  if (body.startsWith("#")) return "option";
  return "prose";
}

function sourceLine(uri: string, line: number, raw: string, indent: number, body: string): Line {
  return {
    id: uri + "#" + line,
    uri,
    line,
    raw,
    indent,
    kind: lineKind(body),
    args: body,
    argStart: indent,
    children: [],
    tokens: [],
  };
}

function attachLine(doc: Document, node: Line, stack: Line[], body: string, offset: number, bom: number): void {
  const indent = node.indent;
  if (body) {
    while (stack.length && stack.at(-1)!.indent - (stack.at(-1)!.line === 0 ? bom : 0) >= indent - offset) stack.pop();

    node.parent = stack.at(-1);
    if (node.parent) node.parent.children.push(node);
    else doc.roots.push(node);
  } else {
    node.parent = stack.at(-1);
    (node.parent?.children ?? doc.roots).push(node);
  }
}

function indentation(doc: Document, node: Line, whitespace: string, offset: number, indentStyle: string): string {
  const line = node.line,
    indent = node.indent;
  if (/[^ \t]/.test(whitespace))
    doc.diagnostics.push(
      diagnostic(
        line,
        offset,
        whitespace.length,
        "indentation-whitespace",
        "Indentation may contain only spaces or tabs.",
      ),
    );

  if (/[ \t]/.test(whitespace) && !/[^ \t]/.test(whitespace)) {
    const style = whitespace.includes("\t") ? "tabs" : "spaces";

    if ((whitespace.includes(" ") && whitespace.includes("\t")) || (indentStyle && style !== indentStyle))
      doc.diagnostics.push(diagnostic(line, 0, indent, "mixed-indentation", "Use a consistent indentation style."));

    indentStyle ||= style;
  }
  return indentStyle;
}

function randomSceneLine(doc: Document, node: Line, body: string): void {
  const line = node.line,
    indent = node.indent;
  const trimmed = body.trimEnd();
  let start = trimmed.length;
  while (start > 0 && !/\s/.test(trimmed[start - 1])) start--;

  // Metadata is entered only for a nonblank body, so its final word is present.
  node.target = trimmed.slice(start);
  node.tokens.push({ line, start: indent + start, length: node.target.length, type: "label" });

  const conditional = /\*if\s+\(/.exec(body);
  const close = body.lastIndexOf(")", start - 1);
  if (conditional && close >= conditional.index + conditional[0].length && /^\s+$/.test(body.slice(close + 1, start))) {
    const open = conditional.index + conditional[0].length - 1;
    addExpression(doc, node, body.slice(open + 1, close), indent + open + 1);
  }
}

function metadataLine(doc: Document, node: Line, body: string): void {
  const line = node.line,
    indent = node.indent;
  if (node.parent?.command === "goto_random_scene") {
    randomSceneLine(doc, node, body);
  } else if (node.parent?.command === "scene_list") {
    // The caller strips leading whitespace and admits only nonblank bodies.
    const m = /^(?:\$\S+\s+)?(\S+)/.exec(body)!;
    node.tokens.push({
      line,
      start: indent + body.indexOf(m[1]),
      length: m[1].length,
      type: "label",
    });
  } else {
    const m = /^(percent|opposed_pair|text)\s+(\w+)/.exec(body);

    if (m) {
      node.tokens.push(
        { line, start: indent, length: m[1].length, type: "keyword" },
        {
          line,
          start: indent + m[1].length + 1,
          length: m[2].length,
          type: "variable",
        },
      );
      narrative(doc, node, indent + m[0].length);
    } else narrative(doc, node, indent);
  }
}

function lineContent(doc: Document, node: Line, body: string): void {
  const line = node.line,
    indent = node.indent;
  if (node.kind === "command" || node.kind === "comment") {
    const m = /^\*(\w+)/.exec(body);

    if (m) {
      node.command = m[1].toLowerCase();
      node.args = body.slice(m[0].length).trimStart();
      node.argStart = indent + body.length - node.args.length;
      node.tokens.push({
        line,
        start: indent,
        length: m[1].length + 1,
        type: "keyword",
      });
      command(doc, node);
    } else doc.diagnostics.push(diagnostic(line, indent, body.length, "command-syntax", "Expected a command name."));
  } else if (node.kind === "metadata") {
    metadataLine(doc, node, body);
  } else if (node.kind === "prose" || node.kind === "option") {
    if (node.kind === "option") node.tokens.push({ line, start: indent, length: 1, type: "operator" });

    narrative(doc, node, indent + (node.kind === "option" ? 1 : 0));
  }
}

function checkAlternative(doc: Document, node: Line, previousSibling: Map<Line | undefined, Line>): void {
  const line = node.line;
  if (!["blank", "comment"].includes(node.kind)) {
    const previous = previousSibling.get(node.parent);

    if (
      ["else", "elseif", "elsif"].includes(node.command ?? "") &&
      !["if", "elseif", "elsif"].includes(previous?.command ?? "")
    )
      doc.diagnostics.push(
        diagnostic(
          line,
          node.indent,
          node.raw.length - node.indent,
          "orphan-alternative",
          "This alternative has no matching *if at the same indentation.",
        ),
      );

    previousSibling.set(node.parent, node);
  }
}

function enterBlock(
  doc: Document,
  node: Line,
  body: string,
  stack: Line[],
  labelRegions: Map<Line, Set<number>>,
): void {
  const line = node.line,
    indent = node.indent;
  if (!body || node.kind === "comment") return;
  if (node.command === "label" && node.parent) {
    const regions = labelRegions.get(node.parent) ?? new Set<number>();
    regions.add(node.indent);
    labelRegions.set(node.parent, regions);
  }
  if (
    node.parent &&
    node.parent.kind !== "metadata" &&
    node.parent.kind !== "option" &&
    !labelRegions.get(node.parent)?.has(node.indent) &&
    !blocks.has(node.parent.command ?? "") &&
    !["goto", "goto_scene", "redirect_scene", "gotoref", "finish", "ending", "return", "abort", "restart"].includes(
      node.parent.command ?? "",
    ) &&
    node.parent.inlineText === undefined
  )
    doc.diagnostics.push(
      diagnostic(line, 0, Math.max(1, indent), "unexpected-indent", "Unexpected indentation after a non-block line."),
    );

  stack.push(node);
}

function checkMissingBlocks(doc: Document): void {
  for (const node of doc.lines) {
    const name = node.command ?? "";
    if (
      blocks.has(name) &&
      node.inlineText === undefined &&
      !node.children.some(
        (c) => c.kind !== "blank" && (c.kind !== "comment" || ["if", "elseif", "elsif", "else"].includes(name)),
      )
    )
      doc.diagnostics.push(
        diagnostic(
          node.line,
          node.indent,
          node.raw.length - node.indent,
          "missing-block",
          "Expected an indented block.",
        ),
      );
  }
}

/**
 * Build a recovering indentation tree and line-local expression tokens.
 * Does not read files or execute source code. Keeps original text/UTF-16 positions, including
 * CRLF input; the caller supplies the document version for later freshness checks.
 * Narrative dialogue is intentionally unresolved until project analysis.
 */
export function parseDocument(uri: string, text: string, version = 0): Document {
  const doc: Document = {
    uri,
    text,
    version,
    scene: sceneName(uri),
    lines: [],
    roots: [],
    diagnostics: [],
  };
  const stack: Line[] = [];
  const previousSibling = new Map<Line | undefined, Line>();
  const labelRegions = new Map<Line, Set<number>>();
  let indentStyle = "";
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  for (const [line, raw] of text.split(/\r\n|\n|\r/).entries()) {
    const offset = line === 0 ? bom : 0;
    const whitespace = /^\s*/.exec(raw.slice(offset))![0];
    const indent = offset + whitespace.length;
    const body = raw.trim() ? raw.slice(indent) : "";
    const node = sourceLine(uri, line, raw, indent, body);
    attachLine(doc, node, stack, body, offset, bom);
    if (body) indentStyle = indentation(doc, node, whitespace, offset, indentStyle);
    if (body && ((node.parent && metadata.has(node.parent.command ?? "")) || node.parent?.kind === "metadata"))
      node.kind = "metadata";
    lineContent(doc, node, body);
    checkAlternative(doc, node, previousSibling);
    doc.lines.push(node);
    enterBlock(doc, node, body, stack, labelRegions);
  }
  checkMissingBlocks(doc);
  return doc;
}
