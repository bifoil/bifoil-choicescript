import {
  type Analysis,
  type Position,
  range,
  type Range,
  tokenModifiers as modifiers,
  tokenTypes as legend
} from "./types.js";
import { validVariableName } from "./names.js";
import { commandDocs } from "./parser.js";

export function tokenAt(a: Analysis, uri: string, p: Position) {
  return a.tokens
    .get(uri)
    ?.find((t) => t.line === p.line && p.character >= t.start && p.character < t.start + t.length);
}
export function definition(a: Analysis, uri: string, p: Position) {
  const id = tokenAt(a, uri, p)?.symbol,
    s = id ? a.symbols.get(id) : undefined;
  return s ? { uri: s.uri, range: s.range } : null;
}
export function references(a: Analysis, uri: string, p: Position, includeDeclaration = true) {
  const id = tokenAt(a, uri, p)?.symbol;
  const declaration = id ? a.symbols.get(id) : undefined;
  return (id ? (a.references.get(id) ?? []) : []).filter(
    (ref) =>
      includeDeclaration ||
      !declaration ||
      ref.uri !== declaration.uri ||
      JSON.stringify(ref.range) !== JSON.stringify(declaration.range),
  );
}
export function prepareRename(a: Analysis, uri: string, p: Position) {
  const t = tokenAt(a, uri, p);
  if (!t?.symbol || !a.symbols.has(t.symbol) || a.symbols.get(t.symbol)?.kind === "scene") return null;
  return range(t.line, t.start, t.referenceLength ?? t.length);
}
export function rename(a: Analysis, uri: string, p: Position, name: string) {
  if (!/^[A-Za-z]\w*$/.test(name))
    throw new Error("Names must start with a letter and contain only letters, digits, or underscores.");
  if (!prepareRename(a, uri, p)) return null;
  const id = tokenAt(a, uri, p)!.symbol!,
    old = a.symbols.get(id)!;
  if ((old.kind === "global" || old.kind === "local") && !validVariableName(name))
    throw new Error("That name is reserved by ChoiceScript.");
  const affected = new Set(references(a, uri, p).map((ref) => ref.uri));
  const variable = old.kind === "global" || old.kind === "local";
  const visible = (kind: string, sourceUri: string) =>
    kind === "global" || (old.kind === "global" ? affected.has(sourceUri) : sourceUri === old.uri);
  const arraySymbols = new Set(
    [...a.documents.values()].flatMap((doc) =>
      doc.lines
        .filter((line) => line.command === "create_array" || line.command === "temp_array")
        .flatMap((line) => (line.targetToken?.symbol ? [line.targetToken.symbol] : [])),
    ),
  );
  const generatedBy = (base: string, candidate: string) =>
    candidate.startsWith(base + "_") && /^(?:\d+(?:_\d+)*|count)$/.test(candidate.slice(base.length + 1));
  const target = name.toLowerCase();
  if (
    [...a.symbols.values()].some(
      (s) =>
        s.id !== id &&
        (old.kind === "label"
          ? s.kind === "label" && s.uri === old.uri && s.name === target
          : variable &&
            (s.kind === "global" || s.kind === "local") &&
            visible(s.kind, s.uri) &&
            (s.name === target ||
              (arraySymbols.has(id) && generatedBy(target, s.name)) ||
              (arraySymbols.has(s.id) && generatedBy(s.name, target)))),
    ) ||
    (variable &&
      (generatedBy("param", target) || (arraySymbols.has(id) && target === "param")) &&
      [...a.documents.values()].some(
        (doc) =>
          (old.kind === "global" ? affected.has(doc.uri) : doc.uri === old.uri) &&
          doc.lines.some((line) => line.command === "params"),
      ))
  )
    throw new Error("That name already exists in this scope.");
  // Implicit runtime names cannot be rewritten at a source declaration.
  const explicitOverlap =
    variable &&
    [...a.symbols.values()].some(
      (s) =>
        s.id !== id &&
        (s.kind === "global" || s.kind === "local") &&
        visible(s.kind, s.uri) &&
        ((arraySymbols.has(id) && generatedBy(old.name, s.name)) ||
          (arraySymbols.has(s.id) && generatedBy(s.name, old.name))),
    );
  const parameterOverlap =
    old.kind === "local" &&
    generatedBy("param", old.name) &&
    a.documents.get(old.uri)?.lines.some((line) => line.command === "params");
  if (explicitOverlap || parameterOverlap)
    throw new Error("This name overlaps an implicit runtime variable; rename it manually.");
  const changes: Record<string, { range: Range; newText: string }[]> = {};
  for (const ref of references(a, uri, p)) (changes[ref.uri] ??= []).push({ range: ref.range, newText: name });
  return { changes };
}
export function hover(a: Analysis, uri: string, p: Position) {
  const doc = a.documents.get(uri),
    line = doc?.lines[p.line],
    t = tokenAt(a, uri, p);
  if (!line) return null;
  if (t?.type === "keyword" && line.command)
    return {
      contents: {
        kind: "markdown" as const,
        value:
          "**`*" +
          line.command +
          "`**\n\n" +
          (Object.hasOwn(commandDocs, line.command) ? commandDocs[line.command] : "ChoiceScript command."),
      },
    };
  if (t?.symbol) {
    const s = a.symbols.get(t.symbol),
      v = a.values.get(t.symbol),
      inferred = /^(number|string|boolean)Variable$/.exec(t.type)?.[1],
      types = inferred ? [inferred] : t.type === "variable" ? ["unknown"] : v?.types;
    if (s)
      return {
        contents: {
          kind: "markdown" as const,
          value: "**" + s.name + "** — " + s.kind + (types ? "\n\nType: `" + types.join(" | ") + "`" : ""),
        },
      };
  }
  return null;
}
export function completions(a: Analysis, uri: string, p: Position) {
  const line = a.documents.get(uri)?.lines[p.line],
    before = line?.raw.slice(0, p.character) ?? "";
  if (/^\s*\*\w*$/.test(before))
    return Object.entries(commandDocs).map(([name, documentation]) => ({
      label: "*" + name,
      insertText: name,
      kind: 14 as const,
      documentation: { kind: "markdown" as const, value: documentation },
    }));
  if (/\*(?:goto_scene|gosub_scene|redirect_scene)\s+\w*$/.test(before))
    return [...a.symbols.values()].filter((s) => s.kind === "scene").map((s) => ({ label: s.name, kind: 17 as const }));
  if (/\*(?:goto|gosub)\s+\w*$/.test(before))
    return [...a.symbols.values()]
      .filter((s) => s.kind === "label" && s.uri === uri)
      .map((s) => ({ label: s.name, kind: 18 as const }));
  if (line?.kind === "command" || /[$@]!{0,2}\{[^}]*$/.test(before))
    return [...a.symbols.values()]
      .filter((s) => s.kind === "global" || (s.kind === "local" && s.uri === uri))
      .map((s) => ({
        label: s.name,
        kind: 6 as const,
        detail: a.values.get(s.id)?.types.join(" | ") ?? s.kind,
      }));
  return [];
}
export function documentSymbols(a: Analysis, uri: string) {
  return [...a.symbols.values()]
    .filter((s) => s.uri === uri && s.kind !== "scene")
    .map((s) => ({
      name: s.name,
      kind: s.kind === "label" ? (12 as const) : (13 as const),
      range: s.range,
      selectionRange: s.range,
    }));
}
export function folding(a: Analysis, uri: string) {
  return (
    a.documents
      .get(uri)
      ?.lines.filter((l) => l.children.length)
      .map((l) => {
        let end = l.line;
        const visit = (nodes: typeof l.children) => {
          for (const n of nodes) {
            end = Math.max(end, n.line);
            visit(n.children);
          }
        };
        visit(l.children);
        return {
          startLine: l.line,
          endLine: end,
          kind: l.command === "comment" ? "comment" : "region",
        };
      })
      .filter((f) => f.endLine > f.startLine) ?? []
  );
}
export function selections(a: Analysis, uri: string, positions: Position[]) {
  return positions.map((p) => {
    const doc = a.documents.get(uri),
      line = doc?.lines[p.line];
    const full: Range = {
      start: { line: 0, character: 0 },
      end: {
        line: Math.max(0, (doc?.lines.length ?? 1) - 1),
        character: doc?.lines.at(-1)?.raw.length ?? 0,
      },
    };
    const parent = {
      range: line ? range(p.line, 0, line.raw.length) : full,
      parent: { range: full },
    };
    const t = tokenAt(a, uri, p);
    return t ? { range: range(t.line, t.start, t.length), parent } : parent;
  });
}
export function encodeTokens(a: Analysis, uri: string) {
  let previousLine = 0,
    previousChar = 0;
  const data: number[] = [];
  for (const t of a.tokens.get(uri) ?? []) {
    const type = legend.indexOf(t.type);
    if (type < 0 || t.length <= 0) continue;
    const delta = t.line - previousLine;
    data.push(
      delta,
      delta === 0 ? t.start - previousChar : t.start,
      t.length,
      type,
      (t.modifiers ?? []).reduce((mask, m) => mask | (1 << modifiers.indexOf(m)), 0),
    );
    previousLine = t.line;
    previousChar = t.start;
  }
  return { data };
}
