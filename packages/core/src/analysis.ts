import { parseDocument, matching } from './parser.js';
import { evaluate, lex, parseExpression, valueGroups } from './expression.js';
import {
  type Analysis,
  type Document,
  type Line,
  type Span,
  type Value,
  type SymbolInfo,
  type Diagnostic,
  range,
  diagnostic,
  literal,
  unknown,
  joinValue,
} from './types.js';
type State = { quote: number; paragraph: boolean; env: Map<string, Value> };
type Node = { line: Line; next: string[] };
type Waiting = {
  context: string;
  next: string[];
  caller: State;
  callerUri: string;
  restore: boolean;
};
const clone = (s: State): State => ({
  quote: s.quote,
  paragraph: s.paragraph,
  env: new Map(s.env),
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function merge(a: State | undefined, b: State): State {
  if (!a) return clone(b);
  const env = new Map<string, Value>();
  for (const k of new Set([...a.env.keys(), ...b.env.keys()]))
    env.set(k, joinValue(a.env.get(k) ?? unknown(), b.env.get(k) ?? unknown()));
  return { quote: a.quote | b.quote, paragraph: a.paragraph && b.paragraph, env };
}
function equal(a: State | undefined, b: State): boolean {
  return (
    !!a &&
    a.quote === b.quote &&
    a.paragraph === b.paragraph &&
    a.env.size === b.env.size &&
    [...a.env].every(([k, v]) => same(v, b.env.get(k)))
  );
}
function advance(mask: number, char: string, continuation = false): number {
  let next = 0;
  for (const bit of [1, 2, 4])
    if (mask & bit) {
      if (char === '"') next |= bit === 2 ? (continuation ? 2 : 1) : bit === 1 ? 2 : bit;
      else if (char === '“') next |= bit === 1 ? 4 : bit;
      else if (char === '”') next |= bit === 4 ? 1 : bit;
      else next |= bit;
    }
  return next;
}
function graph(doc: Document, nodes: Map<string, Node>): string | undefined {
  function block(lines: Line[], after: string[]): string[] {
    // Non-executable comments must not separate sibling conditional alternatives.
    lines = lines.filter((line) => line.command !== 'comment');
    let next = after;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.command === 'else' || line.command === 'elseif' || line.command === 'elsif') {
        let start = i;
        while (start >= 0 && ['else', 'elseif', 'elsif'].includes(lines[start].command ?? ''))
          start--;
        if (start >= 0 && lines[start].command === 'if') {
          let alternative = next;
          for (let j = i; j >= start; j--) {
            const branch = lines[j];
            const body = block(branch.children, next);
            nodes.set(branch.id, {
              line: branch,
              next: branch.command === 'else' ? body : [...new Set([...body, ...alternative])],
            });
            alternative = [branch.id];
          }
          next = alternative;
          i = start;
          continue;
        }
      }
      if (line.command === 'if' || line.command === 'selectable_if')
        nodes.set(line.id, { line, next: [...new Set([...block(line.children, next), ...next])] });
      else if (line.command === 'choice' || line.command === 'fake_choice') {
        const options = line.children.filter((n) => n.kind !== 'blank' && n.kind !== 'comment');
        const targets = options.flatMap((option) => block([option], next));
        nodes.set(line.id, { line, next: targets.length ? targets : next });
      } else if (
        line.kind === 'metadata' ||
        ['scene_list', 'stat_chart', 'achievement', 'goto_random_scene'].includes(
          line.command ?? '',
        )
      ) {
        nodes.set(line.id, { line, next });
        for (const child of line.children) nodes.set(child.id, { line: child, next: [] });
      } else
        nodes.set(line.id, {
          line,
          next: line.children.length ? block(line.children, next) : next,
        });
      next = [line.id];
    }
    return next;
  }
  return block(doc.roots, [])[0];
}
export interface AnalyzeOptions {
  quoteWarnings?: boolean;
  signal?: AbortSignal;
  maxSteps?: number;
}
export function analyzeProject(
  input: { uri: string; text: string; version?: number }[],
  options: AnalyzeOptions = {},
): Analysis {
  const documents = new Map(input.map((d) => [d.uri, parseDocument(d.uri, d.text, d.version)]));
  const result: Analysis = {
    documents,
    tokens: new Map(),
    diagnostics: new Map(),
    symbols: new Map(),
    references: new Map(),
    values: new Map(),
    wordCounts: new Map(),
    truncated: false,
  };
  const nodes = new Map<string, Node>(),
    entries = new Map<string, string>(),
    scenes = new Map<string, Document>(),
    labels = new Map<string, string>();
  const globals = new Map<string, SymbolInfo>(),
    locals = new Map<string, SymbolInfo>();
  for (const doc of documents.values()) {
    result.diagnostics.set(doc.uri, [...doc.diagnostics]);
    scenes.set(doc.scene, doc);
    const entry = graph(doc, nodes);
    if (entry) entries.set(doc.uri, entry);
    const scene: SymbolInfo = {
      id: 'scene:' + doc.scene,
      name: doc.scene,
      kind: 'scene',
      uri: doc.uri,
      range: range(0, 0, 0),
    };
    result.symbols.set(scene.id, scene);
    for (const line of doc.lines) {
      const c = line.command ?? '';
      const declarations =
        c === 'params'
          ? line.tokens.filter((t) => t.type === 'variable')
          : line.targetToken
            ? [line.targetToken]
            : [];
      for (const token of declarations) {
        const name = line.raw.slice(token.start, token.start + token.length).toLowerCase();
        const kind =
          c === 'label'
            ? 'label'
            : c.startsWith('create')
              ? 'global'
              : c.startsWith('temp') || c === 'params'
                ? 'local'
                : undefined;
        if (!kind) continue;
        const id = kind === 'global' ? 'global:' + name : kind + ':' + doc.uri + ':' + name;
        if (result.symbols.has(id) && kind !== 'local')
          result.diagnostics
            .get(doc.uri)!
            .push(
              diagnostic(
                line.line,
                token.start,
                token.length,
                'duplicate-symbol',
                `Duplicate ${kind} ${name}.`,
              ),
            );
        const symbol: SymbolInfo = {
          id,
          name,
          kind,
          uri: doc.uri,
          range: range(line.line, token.start, token.length),
        };
        result.symbols.set(id, symbol);
        token.symbol = id;
        if (kind === 'global') globals.set(name, symbol);
        if (kind === 'local') locals.set(doc.uri + ':' + name, symbol);
        if (kind === 'label') labels.set(doc.uri + ':' + name, line.id);
      }
    }
  }
  const arrays = [...documents.values()].flatMap((d) =>
    d.lines
      .filter((l) => ['create_array', 'temp_array'].includes(l.command ?? ''))
      .map((l) => ({ uri: d.uri, name: l.target!, local: l.command === 'temp_array' })),
  );
  const resolve = (uri: string, name: string): string =>
    locals.get(uri + ':' + name)?.id ??
    (locals.has(uri + ':' + name.replace(/_(?:\d+(?:_\d+)*|count|\*)$/, ''))
      ? 'local:' + uri + ':' + name
      : (globals.get(name)?.id ?? 'global:' + name));
  const activeResolve = (state: State, uri: string, name: string): string => {
    const id = resolve(uri, name);
    return id.startsWith('local:') && !state.env.has(id) && !state.env.has(id + '_*')
      ? 'global:' + name
      : id;
  };
  const lookup = (state: State, uri: string, name: string): Value =>
    state.env.get(activeResolve(state, uri, name)) ??
    state.env.get(activeResolve(state, uri, name + '_*')) ??
    unknown();
  const assignmentName = (line: Line, state: State): string | undefined => {
    const e = line.targetExpr;
    if (!e) return line.target;
    if (e.kind === 'variable') return e.name;
    if (e.kind === 'indirect') {
      const v = evaluate(e.expr, (n) => lookup(state, line.uri, n));
      return typeof v.constant === 'string' ? v.constant.toLowerCase() : undefined;
    }
    if (e.kind === 'array') {
      let name = e.name;
      for (const index of e.indexes) {
        const v = evaluate(index, (n) => lookup(state, line.uri, n));
        if (v.constant === undefined) return e.name + '_*';
        name += '_' + v.constant;
      }
      return name;
    }
    return undefined;
  };
  const states = new Map<string, State>(),
    observed = new Map<string, State>(),
    queue: { context: string; id: string }[] = [],
    pending = new Set<string>();
  const summaries = new Map<string, State>(),
    waiting = new Map<string, Map<string, Waiting>>();
  function schedule(context: string, id: string, state: State) {
    if (!nodes.has(id)) return;
    const key = context + '\n' + id,
      old = states.get(key),
      joined = merge(old, state);
    if (equal(old, joined)) return;
    states.set(key, joined);
    if (!pending.has(key)) {
      pending.add(key);
      queue.push({ context, id });
    }
  }
  function deliver(w: Waiting, summary: State) {
    const state = clone(summary);
    if (w.restore) {
      for (const k of state.env.keys())
        if (k.startsWith('local:' + w.callerUri + ':')) state.env.delete(k);
      for (const [k, v] of w.caller.env)
        if (k.startsWith('local:' + w.callerUri + ':')) state.env.set(k, v);
    }
    for (const next of w.next) schedule(w.context, next, state);
  }
  function returnState(context: string, state: State) {
    const old = summaries.get(context),
      summary = merge(old, state);
    if (equal(old, summary)) return;
    summaries.set(context, summary);
    for (const w of waiting.get(context)?.values() ?? []) deliver(w, summary);
  }
  const orderedScenes =
    [...documents.values()]
      .find((d) => d.scene === 'startup')
      ?.lines.filter((l) => l.parent?.command === 'scene_list')
      .map((l) =>
        l.raw
          .trim()
          .replace(/^\$\S+\s+/, '')
          .toLowerCase(),
      ) ?? [];
  const initial: State = {
    quote: 1,
    paragraph: true,
    env: new Map([['global:implicit_control_flow', literal(false)]]),
  };
  const start = scenes.get('startup') ?? documents.values().next().value;
  if (start && entries.has(start.uri)) schedule('root', entries.get(start.uri)!, initial);
  let cursor = 0,
    steps = 0;
  const maxSteps = options.maxSteps ?? 200000;
  function textTransfer(line: Line, state: State, collect = false): Span[] {
    const spans: Span[] = [];
    let start = line.inlineText ?? line.indent + (line.kind === 'option' ? 1 : 0),
      mask = state.quote;
    if (line.kind === 'option' || line.inlineText !== undefined) mask = 1;
    let run = start,
      runType = mask === 2 || mask === 4 ? 'dialogue' : 'narrative',
      first = true;
    const emit = (end: number) => {
      if (collect && end > run)
        spans.push({ line: line.line, start: run, length: end - run, type: runType });
    };
    for (let i = start; i < line.raw.length; i++) {
      const match = /^([$@])!{0,2}\{/.exec(line.raw.slice(i));
      if (match) {
        const open = i + match[0].length - 1,
          end = matching(line.raw, open);
        if (end < 0) break;
        const body = line.raw.slice(open + 1, end);
        if (match[1] === '$') {
          const expr = parseExpression(lex(body, line.line, open + 1, []), []),
            v = evaluate(expr, (n) => lookup(state, line.uri, n));
          if (v.constant !== undefined) {
            for (const char of String(v.constant)) mask = advance(mask, char);
          } else if (v.types.includes('string') || v.types.includes('unknown')) mask = 7;
        } else {
          let cut = body.indexOf(' ');
          if (body.startsWith('(')) {
            let depth = 0;
            for (let p = 0; p < body.length; p++) {
              if (body[p] === '(') depth++;
              if (body[p] === ')' && --depth === 0) {
                cut = p + 1;
                break;
              }
            }
          }
          let union = 0;
          for (const alternative of body.slice(cut + 1).split('|')) {
            let q = mask;
            for (const char of alternative) q = advance(q, char);
            union |= q;
          }
          mask = union || 7;
        }
        emit(i);
        i = end;
        run = i + 1;
        runType = mask === 2 || mask === 4 ? 'dialogue' : 'narrative';
        first = false;
        continue;
      }
      if (line.raw[i] === '[') {
        const tag = /^\[[^\]]*\]/.exec(line.raw.slice(i));
        if (tag) {
          i += tag[0].length - 1;
          continue;
        }
      }
      const ch = line.raw[i];
      if (/\S/.test(ch) && !['"', '“', '”'].includes(ch)) first = false;
      if (collect && options.quoteWarnings !== false && ch === '”' && mask === 1)
        result.diagnostics
          .get(line.uri)!
          .push(
            diagnostic(
              line.line,
              i,
              1,
              'quote-unexpected-close',
              'Closing curly dialogue quote has no opening quote on this path.',
              2,
            ),
          );
      if (['"', '“', '”'].includes(ch)) {
        const next = advance(mask, ch, state.paragraph && first);
        const before = mask === 2 || mask === 4,
          after = next === 2 || next === 4;
        if (!before && after) {
          emit(i);
          run = i;
          runType = 'dialogue';
        } else if (before && !after) {
          emit(i + 1);
          run = i + 1;
          runType = 'narrative';
        }
        mask = next;
        first = false;
      }
    }
    emit(line.raw.length);
    if (line.kind !== 'option' && line.inlineText === undefined) {
      state.quote = mask;
      state.paragraph = false;
    }
    return spans;
  }
  function processQueue() {
    while (cursor < queue.length) {
      if (options.signal?.aborted) throw new Error('Analysis cancelled');
      if (++steps > maxSteps) {
        result.truncated = true;
        break;
      }
      const { context, id } = queue[cursor++],
        key = context + '\n' + id;
      pending.delete(key);
      const node = nodes.get(id)!,
        line = node.line,
        s = clone(states.get(key)!);
      observed.set(id, merge(observed.get(id), s));
      const c = line.command ?? '';
      if (line.kind === 'blank') s.paragraph = true;
      if (line.kind === 'prose' || line.kind === 'option' || line.inlineText !== undefined)
        textTransfer(line, s);
      if (
        ['create', 'temp', 'set', 'rand', 'input_text', 'input_number'].includes(c) &&
        line.target
      ) {
        let value =
          c === 'rand' || c === 'input_number'
            ? { types: ['number'] as const }
            : c === 'input_text'
              ? { types: ['string'] as const }
              : evaluate(line.expr, (n) => lookup(s, line.uri, n));
        const name = assignmentName(line, s);
        if (name) {
          const id =
            c === 'create'
              ? 'global:' + name
              : c === 'temp'
                ? 'local:' + line.uri + ':' + name
                : activeResolve(s, line.uri, name);
          if (name.endsWith('_*')) {
            const prefix = id.slice(0, -1);
            for (const [key, prior] of s.env)
              if (key.startsWith(prefix) && !key.endsWith('_count'))
                s.env.set(key, joinValue(prior, { ...value, types: [...value.types] }));
          } else s.env.set(id, { ...value, types: [...value.types] });
          if (name.includes('_')) {
            const base = name.replace(/_\d+(?:_\d+)*$/, '');
            if (base !== name) {
              const key = resolve(line.uri, base + '_*');
              s.env.set(
                key,
                joinValue(s.env.get(key) ?? unknown(), { ...value, types: [...value.types] }),
              );
            }
          }
        } else for (const key of s.env.keys()) s.env.set(key, unknown());
      }
      if (c === 'create_array' || c === 'temp_array') {
        const name = line.target ?? '',
          values = (line.expressions ?? [])
            .slice(1)
            .map((e) => evaluate(e, (n) => lookup(s, line.uri, n))),
          v = values.reduce((a, b) => joinValue(a, b), values[0] ?? unknown());
        const arrayKey = (suffix: string) =>
          (c === 'create_array' ? 'global:' : 'local:' + line.uri + ':') + name + suffix;
        s.env.set(arrayKey('_*'), v);
        const len = evaluate(line.expressions?.[0], (n) => lookup(s, line.uri, n));
        s.env.set(arrayKey('_count'), len);
        if (typeof len.constant === 'number' && len.constant <= 1000)
          for (let i = 1; i <= len.constant; i++)
            s.env.set(arrayKey('_' + i), values.length > 1 ? (values[i - 1] ?? unknown()) : v);
      }
      if (c === 'params') {
        let p = 0;
        for (const t of line.tokens.filter((t) => t.type === 'variable'))
          s.env.set(
            resolve(line.uri, line.raw.slice(t.start, t.start + t.length).toLowerCase()),
            s.env.get('@param' + p++) ?? unknown(),
          );
      }
      if (c === 'delete' || c === 'delete_array')
        s.env.delete(resolve(line.uri, line.target ?? ''));
      if (c === 'setref') {
        const name = evaluate(line.targetExpr, (n) => lookup(s, line.uri, n));
        if (typeof name.constant === 'string')
          s.env.set(
            activeResolve(s, line.uri, name.constant.toLowerCase()),
            evaluate(line.expr, (n) => lookup(s, line.uri, n)),
          );
        else for (const [k] of s.env) s.env.set(k, unknown());
      }
      if (c === 'print') {
        const value = evaluate(line.expr, (n) => lookup(s, line.uri, n));
        if (value.constant !== undefined) {
          for (const char of String(value.constant)) s.quote = advance(s.quote, char);
        } else if (value.types.includes('string') || value.types.includes('unknown')) s.quote = 7;
      }
      if (c === 'script') {
        s.quote = 7;
        for (const k of s.env.keys()) s.env.set(k, unknown());
      }
      if (c === 'return') {
        returnState(context, s);
        continue;
      }
      if (['ending', 'abort', 'restart'].includes(c)) {
        returnState(context.startsWith('call:') ? 'root' : context, s);
        continue;
      }
      if (['goto', 'gosub', 'goto_scene', 'gosub_scene', 'redirect_scene', 'gotoref'].includes(c)) {
        const groups = valueGroups(lex(line.args, line.line, line.argStart, []));
        const reference = (index: number): string | undefined => {
          const group = groups[index];
          if (!group) return undefined;
          const expr = parseExpression(group, [], true);
          if (expr.kind === 'variable') return expr.name;
          if (expr.kind === 'literal') return String(expr.value).toLowerCase();
          if (expr.kind === 'indirect') {
            const v = evaluate(expr.expr, (n) => lookup(s, line.uri, n));
            return v.constant === undefined ? undefined : String(v.constant).toLowerCase();
          }
          return undefined;
        };
        const scene = c.endsWith('_scene')
          ? scenes.get(reference(0) ?? '')
          : documents.get(line.uri);
        let label = c.endsWith('_scene') ? reference(1) : reference(0);
        if (c === 'gotoref') {
          const v = evaluate(
            parseExpression(lex(line.args, line.line, line.argStart, []), []),
            (n) => lookup(s, line.uri, n),
          );
          label = v.constant === undefined ? undefined : String(v.constant).toLowerCase();
        }
        const target = scene
          ? label
            ? labels.get(scene.uri + ':' + label)
            : c.endsWith('_scene') && !groups[1]
              ? entries.get(scene.uri)
              : undefined
          : undefined;
        if (target && scene) {
          const isCall = c.startsWith('gosub');
          if (c.endsWith('_scene'))
            for (const k of s.env.keys())
              if (k.startsWith('local:' + scene.uri + ':')) s.env.delete(k);
          const argOffset = c.endsWith('_scene') ? (groups[1] ? 2 : 1) : 1;
          const argumentsList = valueGroups(lex(line.args, line.line, line.argStart, [])).slice(
            argOffset,
          );
          for (let p = 0; p < argumentsList.length; p++)
            s.env.set(
              '@param' + p,
              evaluate(parseExpression(argumentsList[p], []), (n) => lookup(s, line.uri, n)),
            );
          if (isCall) {
            const callee = 'call:' + target + ':' + s.quote;
            const waits = waiting.get(callee) ?? new Map<string, Waiting>();
            const previous = waits.get(key);
            const w: Waiting = {
              context,
              next: node.next,
              caller: merge(previous?.caller, states.get(key)!),
              callerUri: line.uri,
              restore: c === 'gosub_scene',
            };
            waits.set(key, w);
            waiting.set(callee, waits);
            schedule(callee, target, s);
            if (summaries.has(callee)) deliver(w, summaries.get(callee)!);
          } else schedule(context, target, s);
        } else {
          s.quote = 7;
          for (const k of s.env.keys()) s.env.set(k, unknown());
          // Unknown destinations can reach any matching scene or label. Never seed
          // those destinations with a falsely certain outside-dialogue state.
          const possible = c.endsWith('_scene')
            ? [...entries.values()]
            : [...labels].filter(([k]) => k.startsWith(line.uri + ':')).map(([, v]) => v);
          for (const next of possible) schedule('dynamic:' + line.id, next, s);
          if (c.startsWith('gosub')) for (const next of node.next) schedule(context, next, s);
        }
        continue;
      }
      if (c === 'goto_random_scene') {
        for (const child of line.children) {
          const name = /([\w-]+)\s*$/.exec(child.raw)?.[1]?.toLowerCase();
          const dest = scenes.get(name ?? '');
          if (dest && entries.has(dest.uri)) schedule(context, entries.get(dest.uri)!, s);
        }
        continue;
      }
      if (c === 'finish') {
        const index = orderedScenes.indexOf(documents.get(line.uri)!.scene),
          scene = scenes.get(orderedScenes[index + 1]);
        if (index >= 0 && scene && entries.has(scene.uri))
          schedule(context, entries.get(scene.uri)!, s);
        else returnState(context, s);
        continue;
      }
      if (!node.next.length) returnState(context, s);
      for (const next of node.next) schedule(context, next, s);
    }
  }
  processQueue();
  for (const doc of documents.values())
    if (!doc.lines.some((l) => observed.has(l.id)) && entries.has(doc.uri)) {
      schedule('isolated:' + doc.uri, entries.get(doc.uri)!, initial);
      processQueue();
    }
  for (const doc of documents.values()) {
    const all: Span[] = [],
      diagnostics = result.diagnostics.get(doc.uri)!;
    let words = 0;
    for (const line of doc.lines) {
      const state = observed.get(line.id) ?? { ...initial, quote: 7 };
      let base: Span[] = [];
      if (line.kind === 'prose' || line.kind === 'option' || line.inlineText !== undefined) {
        base = textTransfer(line, clone(state), true);
        words += (
          line.raw
            .slice(line.inlineText ?? line.indent)
            .replace(/\[[^\]]*\]/g, '')
            .match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []
        ).length;
      }
      if (
        options.quoteWarnings !== false &&
        state.quote !== 7 &&
        (state.quote & (state.quote - 1)) !== 0 &&
        line.kind === 'prose'
      )
        diagnostics.push(
          diagnostic(
            line.line,
            line.indent,
            Math.max(1, line.raw.length - line.indent),
            'quote-branch',
            'Incoming paths disagree about whether dialogue is open.',
            2,
          ),
        );
      const overlays = line.tokens.map((t) => ({ ...t }));
      for (const t of overlays) {
        const name = line.raw.slice(t.start, t.start + t.length).toLowerCase();
        if (t.type === 'variable') {
          const alias = arrays.find(
            (a) =>
              (!a.local || a.uri === doc.uri) &&
              name.startsWith(a.name + '_') &&
              /^(?:\d+(?:_\d+)*|count)$/.test(name.slice(a.name.length + 1)),
          );
          const id = t.symbol ?? activeResolve(state, doc.uri, alias?.name ?? name);
          t.symbol = id;
          if (alias) t.referenceLength = alias.name.length;
          let value = lookup(state, doc.uri, name);
          if (t.modifiers?.includes('declaration') && line.expr)
            value = evaluate(line.expr, (n) => lookup(state, line.uri, n));
          if (line.raw[t.start + t.length] === '[') {
            const tail = line.raw.slice(t.start);
            const groups = valueGroups(lex(tail, line.line, t.start, []));
            value = evaluate(parseExpression(groups[0] ?? [], [], true), (n) =>
              lookup(state, line.uri, n),
            );
          }
          if (t.modifiers?.includes('declaration') && line.expr) {
            const v = evaluate(line.expr, (n) => lookup(state, line.uri, n));
            result.values.set(id, v);
          } else result.values.set(id, joinValue(result.values.get(id) ?? value, value));
          const type = value.types.length === 1 ? value.types[0] : undefined;
          if (type && type !== 'unknown') t.type = type + 'Variable';
        } else if (t.type === 'label' && !t.symbol) {
          if (
            line.parent?.command === 'scene_list' ||
            (line.command?.endsWith('_scene') && t === overlays.find((x) => x.type === 'label'))
          )
            t.symbol = 'scene:' + name;
          else {
            let uri = doc.uri;
            if (line.command?.endsWith('_scene')) uri = scenes.get(line.target ?? '')?.uri ?? uri;
            t.symbol = 'label:' + uri + ':' + name;
          }
        }
        if (t.symbol) {
          const refs = result.references.get(t.symbol) ?? [];
          refs.push({ uri: doc.uri, range: range(t.line, t.start, t.referenceLength ?? t.length) });
          result.references.set(t.symbol, refs);
        }
      }
      if (
        line.targetToken &&
        ['goto', 'gosub', 'goto_scene', 'gosub_scene', 'redirect_scene'].includes(
          line.command ?? '',
        ) &&
        /^[a-z]\w*$/i.test(line.target ?? '')
      ) {
        const c = line.command!,
          found = c.endsWith('_scene')
            ? scenes.has(line.target!)
            : labels.has(doc.uri + ':' + line.target);
        if (!found)
          diagnostics.push(
            diagnostic(
              line.line,
              line.targetToken.start,
              line.targetToken.length,
              'missing-target',
              `Unknown ${c.endsWith('_scene') ? 'scene' : 'label'} ${line.target}.`,
            ),
          );
      }
      // Overlay code and markup spans over prose without emitting overlapping LSP tokens.
      const boundaries = [
        ...new Set([...base, ...overlays].flatMap((t) => [t.start, t.start + t.length])),
      ].sort((a, b) => a - b);
      let bold = false,
        italic = false;
      for (let i = 0; i < boundaries.length - 1; i++) {
        const a = boundaries[i],
          b = boundaries[i + 1],
          t =
            overlays.find((t) => t.start <= a && t.start + t.length >= b) ??
            base.find((t) => t.start <= a && t.start + t.length >= b);
        if (!t || b <= a) continue;
        const raw = line.raw.slice(a, b).toLowerCase();
        if (t.type === 'markup') {
          if (raw === '[b]') bold = true;
          if (raw === '[/b]') bold = false;
          if (raw === '[i]') italic = true;
          if (raw === '[/i]') italic = false;
        }
        const modifiers = [
          ...(t.modifiers ?? []),
          ...(bold && t.type !== 'markup' ? ['bold'] : []),
          ...(italic && t.type !== 'markup' ? ['italic'] : []),
        ];
        all.push({ ...t, start: a, length: b - a, modifiers });
      }
    }
    const dedup = new Map(diagnostics.map((d) => [JSON.stringify(d), d]));
    result.diagnostics.set(doc.uri, [...dedup.values()]);
    result.tokens.set(doc.uri, all);
    result.wordCounts.set(doc.uri, words);
  }
  if (options.quoteWarnings !== false)
    for (const [context, s] of summaries)
      if (
        (context === 'root' || context.startsWith('isolated:')) &&
        (s.quote === 2 || s.quote === 4)
      ) {
        const doc = context === 'root' ? start : documents.get(context.slice(9));
        if (doc) {
          const last = doc.lines.findLast((l) => l.kind === 'prose');
          if (last)
            result.diagnostics
              .get(doc.uri)!
              .push(
                diagnostic(
                  last.line,
                  last.indent,
                  Math.max(1, last.raw.length - last.indent),
                  'quote-unclosed',
                  'Dialogue is still open at the end of a resolved story path.',
                  2,
                ),
              );
        }
      }
  return result;
}
