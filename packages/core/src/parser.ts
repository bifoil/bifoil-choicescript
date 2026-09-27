import commands from "./commands.json" with { type: "json" };
import {
  type Document,
  type Line,
  type Span,
  type Expr,
  diagnostic,
  sceneName,
} from "./types.js";
import { lex, parseExpression, valueGroups } from "./expression.js";
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
const metadata = new Set([
  "scene_list",
  "stat_chart",
  "achievement",
  "goto_random_scene",
]);
const expressions = new Set([
  "if",
  "elseif",
  "elsif",
  "selectable_if",
  "print",
  "looplimit",
]);
const declaration = new Set(["create", "temp", "create_array", "temp_array"]);
function addExpression(
  doc: Document,
  node: Line,
  text: string,
  start: number,
  partial = false,
): Expr {
  const tokens = lex(text, node.line, start, doc.diagnostics);
  node.tokens.push(...tokens.map((t) => t.span));
  return parseExpression(tokens, doc.diagnostics, partial);
}
export function matching(text: string, start: number): number {
  let depth = 1,
    quoted = false;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (text[i] === "{") depth++;
    if (text[i] === "}" && !--depth) return i;
  }
  return -1;
}
export function narrative(
  doc: Document,
  node: Line,
  start: number,
  end = node.raw.length,
): void {
  const text = node.raw;
  for (let i = start; i < end; ) {
    const substitution = /^([$@])(!{0,2})\{/.exec(text.slice(i));
    if (substitution) {
      const open = i + substitution[0].length - 1,
        close = matching(text, open);
      if (close < 0 || close >= end) {
        doc.diagnostics.push(
          diagnostic(
            node.line,
            i,
            end - i,
            "interpolation-close",
            "Substitution must close on this line.",
          ),
        );
        node.tokens.push({
          line: node.line,
          start: i,
          length: end - i,
          type: "interpolation",
        });
        break;
      }
      node.tokens.push(
        {
          line: node.line,
          start: i,
          length: substitution[0].length,
          type: "interpolation",
        },
        { line: node.line, start: close, length: 1, type: "interpolation" },
      );
      const body = text.slice(open + 1, close);
      if (substitution[1] === "$") addExpression(doc, node, body, open + 1);
      else {
        let split = -1,
          depth = 0;
        for (let k = 0; k < body.length; k++) {
          if (body[k] === "(") depth++;
          if (body[k] === ")") depth--;
          if (/\s/.test(body[k]) && depth === 0 && k > 0) {
            split = k;
            break;
          }
        }
        if (split < 0)
          doc.diagnostics.push(
            diagnostic(
              node.line,
              i,
              close - i + 1,
              "multireplace-options",
              "Multireplace requires an expression and alternatives separated by |.",
            ),
          );
        else {
          addExpression(doc, node, body.slice(0, split), open + 1);
          const options = body.slice(split + 1);
          if (!options.includes("|"))
            doc.diagnostics.push(
              diagnostic(
                node.line,
                i,
                close - i + 1,
                "multireplace-options",
                "Provide at least two alternatives.",
              ),
            );
          let pos = open + split + 2;
          for (const part of options.split("|")) {
            narrative(doc, node, pos, pos + part.length);
            pos += part.length + 1;
          }
        }
      }
      i = close + 1;
      continue;
    }
    const tag = /^\[\/?(?:b|i|u|s|url|n|c)(?:=[^\]]*)?\/?\]/i.exec(
      text.slice(i),
    );
    if (tag) {
      node.tokens.push({
        line: node.line,
        start: i,
        length: tag[0].length,
        type: "markup",
      });
      i += tag[0].length;
      continue;
    }
    i++;
  }
}
function command(doc: Document, node: Line): void {
  const c = node.command!,
    a = node.args,
    s = node.argStart;
  if (!commandDocs[c] && !["selectable_if"].includes(c))
    doc.diagnostics.push(
      diagnostic(
        node.line,
        node.indent,
        c.length + 1,
        "unknown-command",
        `Unknown ChoiceScript command *${c}.`,
      ),
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
  if (
    declaration.has(c) ||
    [
      "set",
      "setref",
      "delete",
      "delete_array",
      "rand",
      "input_text",
      "input_number",
    ].includes(c)
  ) {
    const ts = lex(a, node.line, s, doc.diagnostics);
    let end = 1;
    if (ts[0]?.text === "{") {
      let depth = 1;
      while (end < ts.length && depth) {
        if (ts[end].text === "{") depth++;
        if (ts[end].text === "}") depth--;
        end++;
      }
    } else
      while (ts[end]?.text === "[") {
        let depth = 1;
        end++;
        while (end < ts.length && depth) {
          if (ts[end].text === "[") depth++;
          if (ts[end].text === "]") depth--;
          end++;
        }
      }
    node.tokens.push(...ts.map((t) => t.span));
    if (ts[0]) {
      node.targetExpr = parseExpression(ts.slice(0, end), [], true);
      node.target = ts
        .slice(0, end)
        .map((t) => t.text)
        .join("")
        .toLowerCase();
      node.targetToken = ts[0].span;
      if (declaration.has(c)) node.targetToken.modifiers = ["declaration"];
    }
    if (!ts[0])
      doc.diagnostics.push(
        diagnostic(
          node.line,
          s,
          1,
          "missing-variable",
          "Expected a variable name.",
        ),
      );
    if (declaration.has(c) && ts[0] && !/^[a-z]\w*$/i.test(ts[0].text))
      doc.diagnostics.push(
        diagnostic(
          node.line,
          s,
          ts[0].text.length,
          "variable-name",
          "Variable names must start with a letter.",
        ),
      );
    let rest = ts.slice(end);
    if (
      c === "set" &&
      rest[0]?.kind === "operator" &&
      !["(", "{"].includes(rest[0].text) &&
      node.targetToken
    )
      node.expr = {
        kind: "binary",
        op: rest[0].text,
        left: {
          kind: "variable",
          name: node.target ?? "",
          token: node.targetToken,
        },
        right: parseExpression(rest.slice(1), doc.diagnostics),
      };
    else if (
      !c.endsWith("_array") &&
      ![
        "rand",
        "input_text",
        "input_number",
        "delete",
        "delete_array",
      ].includes(c)
    )
      node.expr = rest.length
        ? parseExpression(rest, doc.diagnostics)
        : { kind: "unknown" };
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
          a.length,
          "create-literal",
          "*create requires a simple number, boolean, or string literal.",
        ),
      );
    if ((c === "create" || c === "set") && !rest.length)
      doc.diagnostics.push(
        diagnostic(
          node.line,
          s + a.length,
          1,
          "missing-value",
          "Expected a value.",
        ),
      );
    if (c.endsWith("_array")) {
      node.expressions = valueGroups(rest).map((t) =>
        parseExpression(t, doc.diagnostics),
      );
      node.expr = node.expressions[1];
    }
  } else if (expressions.has(c)) {
    let expr = a;
    if (["if", "selectable_if"].includes(c)) {
      let quoted = false,
        depth = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "\\" && quoted) {
          i++;
          continue;
        }
        if (a[i] === '"') quoted = !quoted;
        if (quoted) continue;
        if (a[i] === "(") depth++;
        if (a[i] === ")") depth--;
        if (a[i] === "#" && depth === 0 && (i === 0 || /\s/.test(a[i - 1]))) {
          expr = a.slice(0, i);
          node.inlineText = s + i + 1;
          narrative(doc, node, node.inlineText);
          break;
        }
      }
    }
    node.expr = addExpression(doc, node, expr, s);
    if (!expr.trim())
      doc.diagnostics.push(
        diagnostic(
          node.line,
          s,
          1,
          "missing-expression",
          "Expected an expression.",
        ),
      );
  } else if (
    [
      "label",
      "goto",
      "gosub",
      "goto_scene",
      "gosub_scene",
      "redirect_scene",
      "gotoref",
    ].includes(c)
  ) {
    const ts = lex(a, node.line, s, doc.diagnostics);
    node.tokens.push(...ts.map((t) => t.span));
    for (let i = 0; i < ts.length; i++) {
      if (
        c !== "gotoref" &&
        ts[i].kind === "variable" &&
        (i === 0 || (c.endsWith("_scene") && i === 1))
      )
        ts[i].span.type = "label";
    }
    if (ts[0]) {
      node.targetExpr = parseExpression(valueGroups(ts)[0] ?? [], [], true);
      node.target = ts[0].text.toLowerCase();
      node.targetToken = ts[0].span;
      if (c === "label") node.targetToken.modifiers = ["declaration"];
    }
  } else if (c === "params") {
    const ts = lex(a, node.line, s, doc.diagnostics);
    node.tokens.push(
      ...ts.map((t) => ({ ...t.span, modifiers: ["declaration"] })),
    );
  } else if (["else", "return", "finish", "ending"].includes(c) && a.trim()) {
    if (c === "else")
      doc.diagnostics.push(
        diagnostic(
          node.line,
          s,
          a.length,
          "unexpected-argument",
          "Nothing may follow *else.",
        ),
      );
  } else if (c === "script") {
    /* JavaScript is opaque to the ChoiceScript analyzer. */
  } else if (!blocks.has(c)) narrative(doc, node, s);
}
export function parseDocument(
  uri: string,
  text: string,
  version = 0,
): Document {
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
  let indentStyle = "";
  for (const [line, raw] of text.split(/\r\n|\n|\r/).entries()) {
    const whitespace = /^[ \t]*/.exec(raw)![0],
      indent = whitespace.length,
      body = raw.slice(indent);
    const node: Line = {
      id: uri + "#" + line,
      uri,
      line,
      raw,
      indent,
      kind: !body
        ? "blank"
        : body.startsWith("*comment")
          ? "comment"
          : body.startsWith("*")
            ? "command"
            : body.startsWith("#")
              ? "option"
              : "prose",
      args: body,
      argStart: indent,
      children: [],
      tokens: [],
    };
    if (body) {
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      node.parent = stack.at(-1);
      if (node.parent) node.parent.children.push(node);
      else doc.roots.push(node);
    } else {
      node.parent = stack.at(-1);
      (node.parent?.children ?? doc.roots).push(node);
    }
    if (/[ \t]/.test(whitespace)) {
      const style = whitespace.includes("\t") ? "tabs" : "spaces";
      if (
        (whitespace.includes(" ") && whitespace.includes("\t")) ||
        (indentStyle && style !== indentStyle)
      )
        doc.diagnostics.push(
          diagnostic(
            line,
            0,
            indent,
            "mixed-indentation",
            "Use a consistent indentation style.",
          ),
        );
      indentStyle ||= style;
    }
    if (
      (node.parent && metadata.has(node.parent.command ?? "")) ||
      node.parent?.kind === "metadata"
    )
      node.kind = "metadata";
    if (node.kind === "command" || node.kind === "comment") {
      const m = /^\*(\w+)(?:\s*(.*))?$/.exec(body);
      if (m) {
        node.command = m[1].toLowerCase();
        node.args = m[2] ?? "";
        node.argStart = indent + body.length - node.args.length;
        node.tokens.push({
          line,
          start: indent,
          length: m[1].length + 1,
          type: "keyword",
        });
        command(doc, node);
      } else
        doc.diagnostics.push(
          diagnostic(
            line,
            indent,
            body.length,
            "command-syntax",
            "Expected a command name.",
          ),
        );
    } else if (node.kind === "metadata") {
      if (node.parent?.command === "scene_list") {
        const m = /^(?:\$\S+\s+)?(\w+)/.exec(body);
        if (m)
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
    } else if (node.kind === "prose" || node.kind === "option") {
      if (node.kind === "option")
        node.tokens.push({ line, start: indent, length: 1, type: "operator" });
      narrative(doc, node, indent + (node.kind === "option" ? 1 : 0));
    }
    doc.lines.push(node);
    if (body && node.kind !== "comment") {
      if (
        node.parent &&
        node.parent.kind !== "metadata" &&
        node.parent.kind !== "option" &&
        !blocks.has(node.parent.command ?? "") &&
        node.parent.inlineText === undefined
      )
        doc.diagnostics.push(
          diagnostic(
            line,
            0,
            Math.max(1, indent),
            "unexpected-indent",
            "Unexpected indentation after a non-block line.",
          ),
        );
      stack.push(node);
    }
  }
  for (const node of doc.lines) {
    if (
      blocks.has(node.command ?? "") &&
      node.inlineText === undefined &&
      !node.children.some((c) => !["blank", "comment"].includes(c.kind))
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
    if (["else", "elseif", "elsif"].includes(node.command ?? "")) {
      const siblings = (node.parent?.children ?? doc.roots).filter(
        (n) => !["blank", "comment"].includes(n.kind),
      );
      const previous = siblings[siblings.indexOf(node) - 1];
      if (!["if", "elseif", "elsif"].includes(previous?.command ?? ""))
        doc.diagnostics.push(
          diagnostic(
            node.line,
            node.indent,
            node.raw.length - node.indent,
            "orphan-alternative",
            "This alternative has no matching *if at the same indentation.",
          ),
        );
    }
  }
  return doc;
}
