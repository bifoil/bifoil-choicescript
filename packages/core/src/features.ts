import { type Analysis, type Position, type Range, range } from './types.js';
import { commandDocs } from './parser.js';
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
export function references(a: Analysis, uri: string, p: Position) {
  const id = tokenAt(a, uri, p)?.symbol;
  return id ? (a.references.get(id) ?? []) : [];
}
export function prepareRename(a: Analysis, uri: string, p: Position) {
  const t = tokenAt(a, uri, p);
  if (!t?.symbol || !a.symbols.has(t.symbol) || a.symbols.get(t.symbol)?.kind === 'scene')
    return null;
  return range(t.line, t.start, t.referenceLength ?? t.length);
}
export function rename(a: Analysis, uri: string, p: Position, name: string) {
  if (!/^[A-Za-z]\w*$/.test(name))
    throw new Error(
      'Names must start with a letter and contain only letters, digits, or underscores.',
    );
  if (!prepareRename(a, uri, p)) return null;
  const id = tokenAt(a, uri, p)!.symbol!,
    old = a.symbols.get(id)!;
  if (
    [...a.symbols.values()].some(
      (s) =>
        s.id !== id && s.name === name.toLowerCase() && (s.kind === 'global' || s.uri === old.uri),
    )
  )
    throw new Error('That name already exists in this scope.');
  const changes: Record<string, { range: Range; newText: string }[]> = {};
  for (const ref of references(a, uri, p))
    (changes[ref.uri] ??= []).push({ range: ref.range, newText: name });
  return { changes };
}
export function hover(a: Analysis, uri: string, p: Position) {
  const doc = a.documents.get(uri),
    line = doc?.lines[p.line],
    t = tokenAt(a, uri, p);
  if (!line) return null;
  if (t?.type === 'keyword' && line.command)
    return {
      contents: {
        kind: 'markdown' as const,
        value:
          '**`*' +
          line.command +
          '`**\n\n' +
          (commandDocs[line.command] ?? 'ChoiceScript command.'),
      },
    };
  if (t?.symbol) {
    const s = a.symbols.get(t.symbol),
      v = a.values.get(t.symbol);
    if (s)
      return {
        contents: {
          kind: 'markdown' as const,
          value:
            '**' + s.name + '** — ' + s.kind + (v ? '\n\nType: `' + v.types.join(' | ') + '`' : ''),
        },
      };
  }
  return null;
}
export function completions(a: Analysis, uri: string, p: Position) {
  const line = a.documents.get(uri)?.lines[p.line],
    before = line?.raw.slice(0, p.character) ?? '';
  if (/^\s*\*\w*$/.test(before))
    return Object.entries(commandDocs).map(([name, documentation]) => ({
      label: '*' + name,
      insertText: name,
      kind: 14 as const,
      documentation: { kind: 'markdown' as const, value: documentation },
    }));
  if (/\*(?:goto_scene|gosub_scene|redirect_scene)\s+\w*$/.test(before))
    return [...a.symbols.values()]
      .filter((s) => s.kind === 'scene')
      .map((s) => ({ label: s.name, kind: 17 as const }));
  if (/\*(?:goto|gosub)\s+\w*$/.test(before))
    return [...a.symbols.values()]
      .filter((s) => s.kind === 'label' && s.uri === uri)
      .map((s) => ({ label: s.name, kind: 18 as const }));
  if (line?.kind === 'command' || /[$@]!{0,2}\{[^}]*$/.test(before))
    return [...a.symbols.values()]
      .filter((s) => s.kind === 'global' || (s.kind === 'local' && s.uri === uri))
      .map((s) => ({
        label: s.name,
        kind: 6 as const,
        detail: a.values.get(s.id)?.types.join(' | ') ?? s.kind,
      }));
  return [];
}
export function documentSymbols(a: Analysis, uri: string) {
  return [...a.symbols.values()]
    .filter((s) => s.uri === uri && s.kind !== 'scene')
    .map((s) => ({
      name: s.name,
      kind: s.kind === 'label' ? (12 as const) : (13 as const),
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
          kind: l.command === 'comment' ? 'comment' : 'region',
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
import { tokenTypes as legend, tokenModifiers as modifiers } from './types.js';
