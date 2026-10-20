import { Worklist } from "./worklist.js";
import { narrativeWords } from "./plain-text.js";
import { overlaySegments } from "./spans.js";
import { Environment } from "./environment.js";
import { acquireEnvironmentArena, releaseEnvironmentArena, type NativeEnvironmentArena } from "./native-environment.js";
import { advanceQuote as advance } from "./projection.js";
import { matching, parseDocument } from "./parser.js";
import { evaluate, lex, parseExpression, referenceGroups, valueGroups } from "./expression.js";
import {
  type Analysis,
  diagnostic,
  type Document,
  joinValue,
  type Line,
  literal,
  range,
  type Span,
  type SymbolInfo,
  unknown,
  type Value,
} from "./types.js";

/**
 * Abstract state at a flow point. Quote bits encode outside=1, straight=2, curly=4;
 * unions represent alternative paths and 7 is unknown. Paragraph tracks whether a
 * repeated opening quote can continue dialogue. Stored states are treated as immutable.
 */
type State = { quote: number; paragraph: boolean; env: Environment };
type Node = { line: Line; next: string[] };

/**
 * Continuation subscribed to a callee summary. Scene calls restore the caller's local
 * scope on return while keeping callee effects on globals and narrative quotation.
 */
type Effects = {
  needed: Set<string>;
  written: Set<string>;
  arrays: Set<string>;
  writtenArrays: Set<string>;
  parameters: Set<string>;
};

type Waiting = {
  context: string;
  next: string[];
  caller: State;
  callerUri: string;
  restore: boolean;
  effects?: Effects;
};

const clone = (s: State): State => ({
  quote: s.quote,
  paragraph: s.paragraph,
  env: s.env.clone(),
});

/**
 * Join reachable paths without mutating either input. Missing bindings contribute
 * unknown, quotation unions, and paragraph continuation survives only unanimous agreement.
 */
function merge(a: State | undefined, b: State): State {
  // Inputs are immutable snapshots; transfer clones before any variable write.
  if (!a) return b;

  const env = a.env.shares(b.env) ? a.env : a.env.join(b.env);

  return {
    quote: a.quote | b.quote,
    paragraph: a.paragraph && b.paragraph,
    env,
  };
}

function equal(a: State | undefined, b: State): boolean {
  return !!a && a.quote === b.quote && a.paragraph === b.paragraph && a.env.equals(b.env);
}

/**
 * Build structural successors backwards from each block's continuation.
 * Conditional siblings share the same continuation instead of feeding one branch's
 * exit into the next. Runtime jumps/returns are resolved by transfer, not these edges.
 */
function graph(doc: Document, nodes: Map<string, Node>): string | undefined {
  function block(lines: Line[], after: string[]): string[] {
    // Non-executable comments must not separate sibling conditional alternatives.
    lines = lines.filter((line) => line.command !== "comment");

    let next = after;

    let cursor = lines.length;
    while (cursor > 0) {
      const line = lines[--cursor];

      if (line.command === "else" || line.command === "elseif" || line.command === "elsif") {
        let start = cursor;

        while (start >= 0 && ["else", "elseif", "elsif"].includes(lines[start].command ?? "")) start--;

        if (start >= 0 && lines[start].command === "if") {
          let alternative = next;

          for (let j = cursor; j >= start; j--) {
            const branch = lines[j];
            const body = block(branch.children, next);
            nodes.set(branch.id, {
              line: branch,
              next: branch.command === "else" ? body : [...new Set([...body, ...alternative])],
            });
            alternative = [branch.id];
          }

          next = alternative;
          cursor = start;
          continue;
        }
      }

      if (line.command === "if" || line.command === "selectable_if")
        nodes.set(line.id, {
          line,
          next: [...new Set([...block(line.children, next), ...next])],
        });
      else if (line.command === "choice" || line.command === "fake_choice") {
        const options = line.children.filter((n) => n.kind !== "blank" && n.kind !== "comment");
        const targets = options.flatMap((option) => block([option], next));
        nodes.set(line.id, { line, next: targets.length ? targets : next });
      } else if (
        line.kind === "metadata" ||
        ["scene_list", "stat_chart", "achievement", "goto_random_scene"].includes(line.command ?? "")
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

/**
 * Controls warning presentation, cooperative cancellation, and the transfer-work budget.
 * A zero transfer budget retains syntax assistance without constructing the flow graph.
 * `incompleteProject` seeds isolated entry points with uncertain dialogue; callers that
 * lack scene context also control publication of context-dependent diagnostics.
 */
export interface AnalyzeOptions {
  quoteWarnings?: boolean;
  signal?: AbortSignal;
  maxSteps?: number;
  incompleteProject?: boolean;
  /** Storage oracle for differential tests; both modes perform the same full analysis. */
  environment?: "native" | "javascript";
}

/**
 * Analyze a set of source buffers or parsed/projected documents without editor APIs.
 * Parsed inputs are borrowed and annotated (line IDs and token bindings), not cloned;
 * do not analyze the same mutable Document concurrently. Source strings are parsed here.
 * Calls/loops converge through context summaries and a worklist; maxSteps yields a
 * truncated result, while an observed abort signal throws. Results preserve source URIs
 * and UTF-16 ranges even when internal graph/environment IDs are compact.
 */
export function analyzeProject(
  input: Array<{ uri: string; text: string; version?: number } | Document>,
  options: AnalyzeOptions = {},
): Analysis {
  if (options.environment === "javascript") return analyzeWithEnvironment(input, options);
  if (options.signal?.aborted) throw new Error("Analysis cancelled");
  const arena = acquireEnvironmentArena();
  try {
    return analyzeWithEnvironment(input, options, arena);
  } finally {
    releaseEnvironmentArena(arena);
  }
}

function analyzeWithEnvironment(
  input: Array<{ uri: string; text: string; version?: number } | Document>,
  options: AnalyzeOptions = {},
  arena?: NativeEnvironmentArena,
): Analysis {
  if (options.signal?.aborted) throw new Error("Analysis cancelled");
  const documents = new Map(input.map((d) => [d.uri, "lines" in d ? d : parseDocument(d.uri, d.text, d.version)]));
  const result: Analysis = {
    documents,
    tokens: new Map(),
    diagnostics: new Map(),
    symbols: new Map(),
    references: new Map(),
    values: new Map(),
    wordCounts: new Map(),
    truncated: options.maxSteps === 0,
  };
  const nodes = new Map<string, Node>(),
    entries = new Map<string, string>(),
    scenes = new Map<string, Document>(),
    labels = new Map<string, string>();
  const globals = new Map<string, SymbolInfo>(),
    locals = new Map<string, SymbolInfo>();
  const sourceScopes = new Map<string, number>();
  let documentId = 0;

  for (const doc of documents.values()) {
    sourceScopes.set(doc.uri, documentId);
    // Graph identities are analysis-local; source locations remain in uri/line/range fields.
    for (const line of doc.lines) line.id = documentId + ":" + line.line;

    documentId++;
    result.diagnostics.set(doc.uri, [...doc.diagnostics]);
    scenes.set(doc.scene, doc);

    const entry = options.maxSteps === 0 ? undefined : graph(doc, nodes);

    if (entry) entries.set(doc.uri, entry);

    const scene: SymbolInfo = {
      id: "scene:" + doc.scene,
      name: doc.scene,
      kind: "scene",
      uri: doc.uri,
      range: range(0, 0, 0),
    };
    result.symbols.set(scene.id, scene);

    for (const line of doc.lines) {
      const c = line.command ?? "";
      const declarations =
        c === "params" ? line.tokens.filter((t) => t.type === "variable") : line.targetToken ? [line.targetToken] : [];

      for (const token of declarations) {
        const name = line.raw.slice(token.start, token.start + token.length).toLowerCase();
        const kind =
          c === "label"
            ? "label"
            : c.startsWith("create")
              ? "global"
              : c.startsWith("temp") || c === "params"
                ? "local"
                : undefined;

        if (!kind) continue;

        const id = kind === "global" ? "global:" + name : kind + ":" + doc.uri + ":" + name;

        if (result.symbols.has(id) && kind !== "local")
          result.diagnostics
            .get(doc.uri)!
            .push(diagnostic(line.line, token.start, token.length, "duplicate-symbol", `Duplicate ${kind} ${name}.`));

        const symbol: SymbolInfo = {
          id,
          name,
          kind,
          uri: doc.uri,
          range: range(line.line, token.start, token.length),
        };
        result.symbols.set(id, symbol);
        token.symbol = id;
        if (kind === "global") globals.set(name, symbol);
        if (kind === "local") locals.set(doc.uri + ":" + name, symbol);
        if (kind === "label") labels.set(doc.uri + ":" + name, line.id);
      }
    }
  }

  const arrays = [...documents.values()].flatMap((d) =>
    d.lines
      .filter((l) => ["create_array", "temp_array"].includes(l.command ?? ""))
      .map((l) => ({
        uri: d.uri,
        name: l.target!,
        local: l.command === "temp_array",
      })),
  );

  const localPrefix = (uri: string) => "local:" + sourceScopes.get(uri) + ":";

  const environmentKeys = new Map<string, string>();

  const environmentId = (id: string) => environmentKeys.get(id) ?? id;

  const identifiers = new Map<string, Map<string, { local: string; environment: string; resolved?: string }>>();

  function identifier(uri: string, name: string) {
    let names = identifiers.get(uri);

    if (!names) {
      names = new Map();
      identifiers.set(uri, names);
    }

    let id = names.get(name);

    if (!id) {
      id = { local: "local:" + uri + ":" + name, environment: localPrefix(uri) + name };
      environmentKeys.set(id.local, id.environment);
      names.set(name, id);
    }

    return id;
  }

  const resolve = (uri: string, name: string): string => {
    const id = identifier(uri, name);
    return (id.resolved ??=
      locals.get(uri + ":" + name)?.id ??
      (locals.has(uri + ":" + name.replace(/_(?:\d+(?:_\d+)*|count|\*)$/, ""))
        ? id.local
        : (globals.get(name)?.id ?? "global:" + name)));
  };

  // During observation, retain only bindings actually needed to color/query this
  // line. Flow states still carry the full environment between control-flow joins.
  let reads: Environment | undefined;
  const read = (state: State, key: string): Value | undefined => {
    const value = state.env.get(key);
    if (reads && value !== undefined) reads.set(key, value);
    return value;
  };

  const activeResolve = (state: State, uri: string, name: string): string => {
    const local = identifier(uri, name).local;
    if (reads) {
      read(state, environmentId(local));
      read(state, identifier(uri, name + "_*").environment);
    }

    if (state.env.has(environmentId(local)) || state.env.has(identifier(uri, name + "_*").environment)) return local;

    const id = resolve(uri, name);

    return id.startsWith("local:") &&
      !state.env.has(environmentId(id)) &&
      !state.env.has(identifier(uri, name + "_*").environment)
      ? "global:" + name
      : id;
  };

  const lookup = (state: State, uri: string, name: string): Value =>
    read(state, environmentId(activeResolve(state, uri, name))) ??
    read(state, environmentId(activeResolve(state, uri, name + "_*"))) ??
    unknown();

  const assignmentName = (line: Line, state: State): string | undefined => {
    const e = line.targetExpr;

    if (!e) return line.target;
    if (e.kind === "variable") return e.name;

    if (e.kind === "indirect") {
      const v = evaluate(e.expr, (n) => lookup(state, line.uri, n));
      return typeof v.constant === "string" ? v.constant.toLowerCase() : undefined;
    }

    if (e.kind === "array") {
      let name = e.name;

      for (const index of e.indexes) {
        const v = evaluate(index, (n) => lookup(state, line.uri, n));

        if (v.constant === undefined) return e.name + "_*";

        name += "_" + v.constant;
      }

      return name;
    }

    return undefined;
  };

  // Only joins and externally reachable entries need a retained input for fixed
  // point convergence. Single-predecessor chains can consume their queued input.
  const leaders = new Set([...entries.values(), ...labels.values()]);
  const incoming = new Map<string, number>();
  for (const node of nodes.values()) for (const next of node.next) incoming.set(next, (incoming.get(next) ?? 0) + 1);
  for (const [id, count] of incoming) if (count > 1) leaders.add(id);

  const featureExpressions = new Map<Line, NonNullable<Line["expr"]>[]>();
  if (options.maxSteps !== 0)
    for (const doc of documents.values())
      for (const line of doc.lines) {
        const expressions = [line.expr, line.targetExpr, ...(line.expressions ?? [])].filter(
          (expr): expr is NonNullable<Line["expr"]> => !!expr,
        );
        for (const token of line.tokens)
          if (token.type === "variable" && line.raw[token.start + token.length] === "[") {
            const groups = valueGroups(lex(line.raw.slice(token.start), line.line, token.start, []));
            expressions.push(parseExpression(groups[0] ?? [], [], true));
          }
        if (expressions.length) featureExpressions.set(line, expressions);
      }

  const states = new Map<string, State>(),
    observed = new Map<string, State>(),
    queue = new Worklist<{ context: string; id: string }>(),
    priorities = new Map<string, number>(),
    pending = new Set<string>();
  const summaries = new Map<string, State>(),
    waiting = new Map<string, Map<string, Waiting>>();

  /**
   * Join new evidence into one context/node and enqueue only if it changed; pending keys avoid duplicate queue entries.
   */
  function schedule(context: string, id: string, state: State) {
    if (!nodes.has(id)) return;

    const key = context + "\n" + id,
      old = states.get(key),
      joined = merge(old, state);

    if (equal(old, joined)) return;

    states.set(key, joined);

    if (!pending.has(key)) {
      pending.add(key);
      queue.push({ context, id }, priorities.get(id)!);
    }
  }

  /**
   * Resume a subscribed caller from a callee summary, restoring scene-local scope for gosub_scene.
   */
  function deliver(w: Waiting, summary: State) {
    const state = clone(summary);
    if (w.effects) {
      state.env = w.caller.env.clone();
      const apply = (key: string) => {
        const value = summary.env.get(key);
        if (value === undefined) state.env.delete(key);
        else state.env.set(key, value);
      };
      for (const key of w.effects.written) apply(key);
      if (w.effects.writtenArrays.size)
        for (const key of new Set([...w.caller.env.keys(), ...summary.env.keys()]))
          if (arrayKey(w.effects.writtenArrays, key)) apply(key);
      apply("@param_count");
      for (let i = 0; i < maximumArguments; i++) apply("@param" + i);
      for (const scope of w.effects.parameters) {
        apply(scope + "param_count");
        for (let i = 1; i <= maximumArguments; i++) apply(scope + "param_" + i);
      }
    }

    if (w.restore) {
      state.env.deletePrefix("local:");
      for (const [k, v] of w.caller.env.entriesWithPrefix(localPrefix(w.callerUri))) state.env.set(k, v);
    }

    for (const next of w.next) schedule(w.context, next, state);
  }

  /** Join a callee exit and revisit subscribers only when its summary gains information. */
  function returnState(context: string, state: State) {
    const old = summaries.get(context),
      summary = merge(old, state);

    if (equal(old, summary)) return;

    summaries.set(context, summary);
    for (const w of waiting.get(context)?.values() ?? []) deliver(w, summary);
  }

  const orderedScenes =
    [...documents.values()]
      .find((d) => d.scene === "startup")
      ?.lines.filter((l) => l.parent?.command === "scene_list" && l.kind === "metadata")
      .map((l) => l.raw.trim().replace(/^\$\S+\s+/, "")) ?? [];

  if (orderedScenes[0] !== "startup") orderedScenes.unshift("startup");

  const effectCache = new Map<string, Effects | undefined>();
  const arrayKey = (prefixes: Set<string>, key: string): boolean => {
    for (const prefix of prefixes)
      if (key.startsWith(prefix) && /^(?:\d+(?:_\d+)*|count|\*)$/.test(key.slice(prefix.length))) return true;
    return false;
  };

  /**
   * A callee summary depends only on bindings its reachable body can inspect or
   * change. Other caller bindings pass through untouched on return. Unknown host
   * code or indirection disables this optimization, retaining the full environment.
   * Walking both nested calls and their continuations includes transitive effects;
   * visited nodes bound recursion without dropping any reachable body.
   */
  function calleeEffects(target: string): Effects | undefined {
    if (effectCache.has(target)) return effectCache.get(target);
    effectCache.set(target, undefined);
    const result: Effects = {
      needed: new Set(),
      written: new Set(),
      arrays: new Set(),
      writtenArrays: new Set(),
      parameters: new Set(),
    };
    const pending = [target],
      visited = new Set<string>();
    const add = (line: Line, name: string, writes = false, local?: boolean) => {
      const keys =
        local === true
          ? [localPrefix(line.uri) + name]
          : local === false
            ? ["global:" + name]
            : ["global:" + name, localPrefix(line.uri) + name];
      for (const key of keys) {
        result.needed.add(key);
        if (writes) result.written.add(key);
      }
    };
    const array = (line: Line, name: string, writes: boolean, local?: boolean) => {
      const keys =
        local === true
          ? [localPrefix(line.uri) + name + "_"]
          : local === false
            ? ["global:" + name + "_"]
            : ["global:" + name + "_", localPrefix(line.uri) + name + "_"];
      for (const key of keys) {
        result.arrays.add(key);
        if (writes) result.writtenArrays.add(key);
      }
    };
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = nodes.get(id);
      if (!node) continue;
      const line = node.line,
        c = line.command ?? "";
      if (
        c === "script" ||
        c === "setref" ||
        line.tokens.some((t) => t.type === "operator" && line.raw.slice(t.start, t.start + t.length) === "{")
      )
        return undefined;
      for (const token of line.tokens)
        if (token.type === "variable") {
          const name = line.raw.slice(token.start, token.start + token.length).toLowerCase();
          add(line, name);
          add(line, name + "_*");
          const base = name.replace(/_(?:\d+(?:_\d+)*|count)$/, "");
          if (base !== name) {
            add(line, base);
            add(line, base + "_*");
          }
          if (line.raw[token.start + token.length] === "[") array(line, name, false);
        }
      if (["create", "temp", "set", "rand", "input_text", "input_number", "delete"].includes(c) && line.target) {
        const local = c === "create" ? false : c === "temp" ? true : undefined;
        const expr = line.targetExpr;
        if (expr && expr.kind !== "variable" && expr.kind !== "array") return undefined;
        if (expr?.kind === "array") array(line, expr.name, true, local);
        else add(line, line.target, true, local);
        if (line.target.includes("_")) add(line, line.target.replace(/_\d+(?:_\d+)*$/, "") + "_*", true, local);
      }
      if (["create_array", "temp_array", "delete_array"].includes(c) && line.target)
        array(line, line.target, true, c === "create_array" ? false : c === "temp_array" ? true : undefined);
      if (c === "params") {
        result.parameters.add(localPrefix(line.uri));
        for (const token of line.tokens)
          if (token.type === "variable")
            add(line, line.raw.slice(token.start, token.start + token.length).toLowerCase(), true, true);
      }
      if (["return", "ending", "abort", "restart"].includes(c)) continue;
      if (["goto", "gosub", "goto_scene", "gosub_scene", "redirect_scene", "gotoref"].includes(c)) {
        if (c === "gotoref" || line.targetExpr?.kind === "indirect" || line.targetExpr?.kind === "array")
          return undefined;
        const scene = c.endsWith("_scene") ? scenes.get(line.target ?? "") : documents.get(line.uri);
        let label = c.endsWith("_scene") ? undefined : line.target;
        if (c.endsWith("_scene")) {
          const group = referenceGroups(line.args, line.line, line.argStart, [], 2)[1];
          if (group) {
            if (group.length !== 1 || !["reference", "variable", "number", "string", "boolean"].includes(group[0].kind))
              return undefined;
            label = (
              group[0].kind === "string"
                ? String(evaluate(parseExpression(group, [], true), () => unknown()).constant)
                : group[0].text
            ).toLowerCase();
          }
          // A non-call scene transition destroys the active local frame. Keep
          // the existing full-state transfer for those unusual subroutines.
          if (!c.startsWith("gosub")) return undefined;
        }
        const next = scene ? (label ? labels.get(scene.uri + ":" + label) : entries.get(scene.uri)) : undefined;
        if (!next) return undefined;
        pending.push(next);
        if (!c.startsWith("gosub")) continue;
      }
      if (c === "goto_random_scene" || c === "finish" || !node.next.length) return undefined;
      pending.push(...node.next);
    }
    effectCache.set(target, result);
    return result;
  }

  function projectCall(state: State, effects: Effects): State {
    const env = state.env.empty();
    for (const key of effects.needed) {
      const value = state.env.get(key);
      if (value !== undefined) env.set(key, value);
    }
    if (effects.arrays.size)
      for (const [key, value] of state.env) if (arrayKey(effects.arrays, key)) env.set(key, value);
    const count = state.env.get("@param_count");
    if (count) env.set("@param_count", count);
    for (let i = 0; i < maximumArguments; i++) {
      const key = "@param" + i,
        value = state.env.get(key);
      if (value !== undefined) env.set(key, value);
    }
    for (const scope of effects.parameters) {
      for (const key of [
        scope + "param_count",
        ...Array.from({ length: maximumArguments }, (_, i) => scope + "param_" + (i + 1)),
      ]) {
        const value = state.env.get(key);
        if (value !== undefined) env.set(key, value);
      }
    }
    return { ...state, env };
  }

  const initial: State = {
    quote: 1,
    paragraph: true,
    env: arena
      ? arena.environment([["global:implicit_control_flow", literal(false)]])
      : new Environment([["global:implicit_control_flow", literal(false)]]),
  };
  const start = scenes.get("startup") ?? documents.values().next().value;

  for (const doc of new Set([start, ...orderedScenes.map((name) => scenes.get(name)), ...documents.values()]))
    if (doc) for (const line of doc.lines) priorities.set(line.id, priorities.size);

  if (start && entries.has(start.uri)) schedule("root", entries.get(start.uri)!, initial);

  let maximumArguments = 0;
  const clearParameters = (env: Environment) => {
    if (!env.has("@param_count")) return;
    for (let i = 0; i < maximumArguments; i++) env.delete("@param" + i);
    env.delete("@param_count");
  };

  let steps = 0;
  const maxSteps = options.maxSteps ?? 200000;

  /**
   * Apply narrative state to a full line or compact summary. collect additionally emits
   * semantic spans/warnings; ordinary flow passes only need the state transfer.
   * Option labels start with independent quotation and do not advance story dialogue.
   * Multireplace alternatives each inherit the same entry and merge their exits;
   * expression delimiters are skipped, while known rendered values can affect dialogue.
   */
  function textTransfer(
    line: Line,
    state: State,
    collect = false,
    start = line.inlineText ?? line.indent + (line.kind === "option" ? 1 : 0),
    limit = line.raw.length,
    replacement = false,
  ): Span[] {
    const spans: Span[] = [];

    if (line.narrativeSummary) {
      const summary = line.narrativeSummary;

      if (summary.identity) {
        if (
          collect &&
          options.quoteWarnings !== false &&
          summary.identity.range &&
          state.quote !== 7 &&
          (state.quote & (state.quote - 1)) !== 0
        )
          result.diagnostics.get(line.uri)!.push({
            range: summary.identity.range,
            code: "quote-branch",
            source: "ChoiceScript dialogue",
            severity: 2,
            message: "Incoming paths disagree about whether dialogue is open.",
          });

        state.paragraph = summary.identity.paragraph;
        return spans;
      }

      const index = (state.quote - 1) * 2 + Number(state.paragraph);

      if (collect && options.quoteWarnings !== false) {
        const problem = summary.unexpectedClose[index],
          disagreement = summary.disagreements[index];

        if (problem)
          result.diagnostics
            .get(line.uri)!
            .push(
              diagnostic(
                problem.at.line,
                problem.at.character,
                1,
                "quote-unexpected-close",
                "Closing curly dialogue quote has no opening quote on this path." +
                  (problem.count > 1 ? " (" + problem.count + " occurrences in this passage.)" : ""),
                2,
              ),
            );

        if (disagreement)
          result.diagnostics.get(line.uri)!.push({
            range: disagreement,
            code: "quote-branch",
            source: "ChoiceScript dialogue",
            severity: 2,
            message: "Incoming paths disagree about whether dialogue is open.",
          });
      }

      state.quote = summary.quotes[index];
      state.paragraph = summary.paragraphs[index];

      return spans;
    }

    let mask = state.quote;

    if (!replacement && (line.kind === "option" || line.inlineText !== undefined)) mask = 1;

    let run = start,
      runType = mask === 2 || mask === 4 ? "dialogue" : "narrative",
      first = true;
    let unclosedMarkup = false;

    const emit = (end: number) => {
      if (collect && end > run)
        spans.push({
          line: line.line,
          start: run,
          length: end - run,
          type: runType,
        });
    };

    // Plain prose cannot change quote state; avoid scanning every character twice.
    if (/["“”$@\[]/.test(line.raw.slice(start, limit))) {
      let i = start;
      while (i < limit) {
        const match = line.raw[i] === "$" || line.raw[i] === "@" ? /^([$@])!{0,2}\{/.exec(line.raw.slice(i)) : null;

        if (match) {
          const open = i + match[0].length - 1,
            end = matching(line.raw, open);

          if (end < 0 || end >= limit) break;

          emit(i);

          const body = line.raw.slice(open + 1, end);

          if (match[1] === "$") {
            const expr = parseExpression(lex(body, line.line, open + 1, []), []),
              v = evaluate(expr, (n) => lookup(state, line.uri, n));

            if (v.constant !== undefined) {
              for (const char of String(v.constant)) mask = advance(mask, char);
            } else if (v.types.includes("string") || v.types.includes("unknown")) mask = 7;
          } else {
            let cut = body.search(/\s/);

            if (body.startsWith("(")) {
              let depth = 0;

              for (let p = 0; p < body.length; p++) {
                if (body[p] === "(") depth++;

                if (body[p] === ")" && --depth === 0) {
                  cut = p + 1;
                  break;
                }
              }
            }

            let union = 0,
              position = open + cut + 2;

            for (const alternative of body.slice(cut + 1).split("|")) {
              const branch = {
                ...state,
                quote: mask,
                paragraph: state.paragraph && first,
              };
              spans.push(...textTransfer(line, branch, collect, position, position + alternative.length, true));
              union |= branch.quote;
              position += alternative.length + 1;
            }

            mask = union || 7;
          }

          i = end + 1;
          run = i;
          runType = mask === 2 || mask === 4 ? "dialogue" : "narrative";
          first = false;
          continue;
        }

        if (line.raw[i] === "[" && !unclosedMarkup) {
          const close = line.raw.indexOf("]", i + 1);
          if (close >= 0 && close < limit) {
            i = close + 1;
            continue;
          }
          unclosedMarkup = true;
        }

        const ch = line.raw[i];
        const quote = ch === '"' || ch === "“" || ch === "”";

        if (/\S/.test(ch) && !quote) first = false;

        if (collect && options.quoteWarnings !== false && ch === "”" && mask === 1)
          result.diagnostics
            .get(line.uri)!
            .push(
              diagnostic(
                line.line,
                i,
                1,
                "quote-unexpected-close",
                "Closing curly dialogue quote has no opening quote on this path.",
                2,
              ),
            );

        if (quote) {
          const next = advance(mask, ch, state.paragraph && first);
          const before = mask === 2 || mask === 4,
            after = next === 2 || next === 4;

          if (!before && after) {
            emit(i);
            run = i;
            runType = "dialogue";
          } else if (before && !after) {
            emit(i + 1);
            run = i + 1;
            runType = "narrative";
          }

          mask = next;
          first = false;
        }
        i++;
      }
    }

    emit(limit);

    if (replacement || (line.kind !== "option" && line.inlineText === undefined)) {
      state.quote = mask;
      state.paragraph = false;
    }

    return spans;
  }

  // Keep this set aligned with transfer cases below: an omitted writer could mutate
  // an environment still shared by sibling paths through the quotation-only fast path.
  const writesEnvironment = new Set([
    "create",
    "temp",
    "set",
    "rand",
    "input_text",
    "input_number",
    "create_array",
    "temp_array",
    "params",
    "delete",
    "delete_array",
    "setref",
    "script",
    "goto",
    "gotoref",
    "gosub",
    "goto_scene",
    "gosub_scene",
    "redirect_scene",
    "goto_random_scene",
    "finish",
  ]);

  /**
   * Run abstract transfers until convergence or the shared work budget is exhausted.
   * Clone before any environment write; quotation-only transfers may share the environment.
   * Observations join contexts for display, while scheduling remains context-specific.
   */
  function* liveEnvironments(): IterableIterator<Environment> {
    yield initial.env;
    for (const state of states.values()) yield state.env;
    for (const state of observed.values()) yield state.env;
    for (const state of summaries.values()) yield state.env;
    for (const callers of waiting.values()) for (const caller of callers.values()) yield caller.caller.env;
  }

  function processQueue() {
    while (queue.size) {
      if (arena?.needsCollection) arena.collect(liveEnvironments());
      if (options.signal?.aborted) throw new Error("Analysis cancelled");

      if (++steps > maxSteps) {
        result.truncated = true;
        break;
      }

      const { context, id } = queue.pop()!,
        key = context + "\n" + id;
      pending.delete(key);

      const node = nodes.get(id)!,
        line = node.line,
        c = line.command ?? "",
        input = states.get(key)!;
      if (!leaders.has(id)) states.delete(key);
      const s = writesEnvironment.has(c) || !node.next.length ? clone(input) : { ...input };
      reads = input.env.empty();
      for (const token of line.tokens)
        if (token.type === "variable") {
          const name = line.raw.slice(token.start, token.start + token.length).toLowerCase();
          lookup(input, line.uri, name);
          // Generated element aliases also need the active array's scope marker.
          const base = name.replace(/_(?:\d+(?:_\d+)*|count)$/, "");
          if (base !== name) lookup(input, line.uri, base);
        }
      for (const expr of featureExpressions.get(line) ?? []) evaluate(expr, (name) => lookup(input, line.uri, name));
      if (line.kind === "blank") s.paragraph = true;
      if (line.kind === "prose" || line.kind === "option" || line.inlineText !== undefined) textTransfer(line, s);
      const observation = { quote: input.quote, paragraph: input.paragraph, env: reads };
      reads = undefined;
      observed.set(id, merge(observed.get(id), observation));

      if (["create", "temp", "set", "rand", "input_text", "input_number"].includes(c) && line.target) {
        let value =
          c === "rand" || c === "input_number"
            ? { types: ["number"] as const }
            : c === "input_text"
              ? { types: ["string"] as const }
              : evaluate(line.expr, (n) => lookup(s, line.uri, n));
        const name = assignmentName(line, s);

        if (name) {
          const id =
            c === "create"
              ? "global:" + name
              : c === "temp"
                ? localPrefix(line.uri) + name
                : environmentId(activeResolve(s, line.uri, name));

          if (name.endsWith("_*")) {
            const prefix = id.slice(0, -1);

            for (const [key, prior] of s.env)
              if (key.startsWith(prefix) && !key.endsWith("_count")) s.env.set(key, joinValue(prior, value));
          } else s.env.set(id, value);

          if (name.includes("_")) {
            const base = name.replace(/_\d+(?:_\d+)*$/, "");

            if (base !== name) {
              const key = environmentId(resolve(line.uri, base + "_*"));
              s.env.set(key, joinValue(s.env.get(key) ?? unknown(), value));
            }
          }
        } else for (const key of s.env.keys()) s.env.set(key, unknown());
      }

      if (c === "create_array" || c === "temp_array") {
        const name = line.target ?? "",
          values = (line.expressions ?? []).slice(1).map((e) => evaluate(e, (n) => lookup(s, line.uri, n))),
          v = values.reduce((a, b) => joinValue(a, b), values[0] ?? unknown());

        const arrayKey = (suffix: string) => (c === "create_array" ? "global:" : localPrefix(line.uri)) + name + suffix;

        s.env.set(arrayKey("_*"), v);

        const len = evaluate(line.expressions?.[0], (n) => lookup(s, line.uri, n));
        s.env.set(arrayKey("_count"), len);

        if (typeof len.constant === "number" && len.constant <= 1000)
          for (let i = 1; i <= len.constant; i++)
            s.env.set(arrayKey("_" + i), values.length > 1 ? (values[i - 1] ?? unknown()) : v);
      }

      if (c === "params") {
        const count = s.env.get("@param_count");
        s.env.set(localPrefix(line.uri) + "param_count", count ?? unknown());

        let p = 0;

        for (const t of line.tokens.filter((t) => t.type === "variable")) {
          const value = s.env.get("@param" + p) ?? unknown();
          s.env.set(environmentId(resolve(line.uri, line.raw.slice(t.start, t.start + t.length).toLowerCase())), value);
          s.env.set(localPrefix(line.uri) + "param_" + ++p, value);
        }

        if (typeof count?.constant === "number")
          for (; p < count.constant; p++)
            s.env.set(localPrefix(line.uri) + "param_" + (p + 1), s.env.get("@param" + p) ?? unknown());

        // The interpreter consumes all supplied parameters at *params.
        clearParameters(s.env);
      }

      if (c === "delete" || c === "delete_array") {
        const name = assignmentName(line, s);

        if (name) {
          if (c === "delete") s.env.delete(environmentId(activeResolve(s, line.uri, name)));
          else {
            const key = environmentId(activeResolve(s, line.uri, name + "_count")).replace(/_count$/, "");

            for (const candidate of s.env.keys())
              if (
                candidate.startsWith(key + "_") &&
                /^(?:\d+(?:_\d+)*|count|\*)$/.test(candidate.slice(key.length + 1))
              )
                s.env.delete(candidate);
          }
        } else for (const key of s.env.keys()) s.env.set(key, unknown());
      }

      if (c === "setref") {
        const name = evaluate(line.targetExpr, (n) => lookup(s, line.uri, n));

        if (typeof name.constant === "string")
          s.env.set(
            environmentId(activeResolve(s, line.uri, name.constant.toLowerCase())),
            evaluate(line.expr, (n) => lookup(s, line.uri, n)),
          );
        else for (const [k] of s.env) s.env.set(k, unknown());
      }

      if (c === "print") {
        const value = evaluate(line.expr, (n) => lookup(s, line.uri, n));

        if (value.constant !== undefined) {
          for (const char of String(value.constant)) s.quote = advance(s.quote, char);
        } else if (value.types.includes("string") || value.types.includes("unknown")) s.quote = 7;
      }

      if (c === "script") {
        s.quote = 7;
        for (const k of s.env.keys()) s.env.set(k, unknown());
      }

      if (c === "return") {
        returnState(context, s);
        continue;
      }

      if (["ending", "abort", "restart"].includes(c)) {
        returnState(context.startsWith("call:") ? "root" : context, s);
        continue;
      }

      if (["goto", "gosub", "goto_scene", "gosub_scene", "redirect_scene", "gotoref"].includes(c)) {
        const groups =
          c === "gotoref"
            ? valueGroups(lex(line.args, line.line, line.argStart, []))
            : referenceGroups(line.args, line.line, line.argStart, [], c.endsWith("_scene") ? 2 : 1);

        const reference = (index: number): string | undefined => {
          const group = groups[index];

          if (!group) return undefined;
          const normalize = (value: string) => (c.endsWith("_scene") && index === 0 ? value : value.toLowerCase());
          if (group[0]?.kind === "reference") return normalize(group[0].text);

          const expr = parseExpression(group, [], true);

          if (expr.kind === "variable") return normalize(group[0].text);
          if (expr.kind === "literal") return normalize(String(expr.value));

          if (expr.kind === "indirect") {
            const v = evaluate(expr.expr, (n) => lookup(s, line.uri, n));
            return v.constant === undefined ? undefined : normalize(String(v.constant));
          }

          return undefined;
        };

        const sceneName = c.endsWith("_scene") ? reference(0) : undefined;
        const scene = c.endsWith("_scene") ? scenes.get(sceneName ?? "") : documents.get(line.uri);
        let label = c.endsWith("_scene") ? reference(1) : reference(0);

        if (c === "gotoref") {
          const v = evaluate(parseExpression(lex(line.args, line.line, line.argStart, []), []), (n) =>
            lookup(s, line.uri, n),
          );
          label = v.constant === undefined ? undefined : String(v.constant).toLowerCase();
        }

        const target = scene
          ? label
            ? labels.get(scene.uri + ":" + label)
            : c.endsWith("_scene") && !groups[1]
              ? entries.get(scene.uri)
              : undefined
          : undefined;

        if (target && scene) {
          const isCall = c.startsWith("gosub");
          const argOffset = c.endsWith("_scene") ? (groups[1] ? 2 : 1) : 1;
          // Capture arguments in the caller before a recursive scene call clears
          // that scene's local environment, or parameter registers are replaced.
          const argumentsList = groups
            .slice(argOffset)
            .map((group) => evaluate(parseExpression(group, []), (n) => lookup(s, line.uri, n)));

          if (c.endsWith("_scene")) s.env.deletePrefix("local:");
          clearParameters(s.env);

          maximumArguments = Math.max(maximumArguments, argumentsList.length);
          s.env.set("@param_count", literal(argumentsList.length));
          for (let p = 0; p < argumentsList.length; p++) s.env.set("@param" + p, argumentsList[p]);

          if (isCall) {
            const effects = calleeEffects(target);
            const callee = "call:" + target + ":" + s.quote;
            const waits = waiting.get(callee) ?? new Map<string, Waiting>();
            const previous = waits.get(key);
            const w: Waiting = {
              context,
              next: node.next,
              caller: merge(previous?.caller, input),
              callerUri: line.uri,
              restore: c === "gosub_scene",
              effects,
            };
            waits.set(key, w);
            waiting.set(callee, waits);
            schedule(callee, target, effects ? projectCall(s, effects) : s);
            if (summaries.has(callee)) deliver(w, summaries.get(callee)!);
          } else schedule(context, target, s);
        } else {
          s.quote = 7;
          for (const k of s.env.keys()) s.env.set(k, unknown());

          // Unknown destinations can reach any matching scene or label. Never seed
          // those destinations with a falsely certain outside-dialogue state.
          // A known but absent file/label is a broken or incomplete project,
          // not an instruction to enter every scene. Only dynamic destinations
          // need conservative fan-out, shared across jump sites to bound work.
          const possible = c.endsWith("_scene")
            ? sceneName === undefined
              ? [...entries.values()]
              : scene && label === undefined && groups[1]
                ? [...labels].filter(([k]) => k.startsWith(scene.uri + ":")).map(([, v]) => v)
                : []
            : label === undefined
              ? [...labels].filter(([k]) => k.startsWith(line.uri + ":")).map(([, v]) => v)
              : [];

          for (const next of possible) schedule("dynamic", next, s);
          if (c.startsWith("gosub")) for (const next of node.next) schedule(context, next, s);
        }

        continue;
      }

      if (c === "goto_random_scene") {
        for (const child of line.children) {
          const dest = scenes.get(child.target ?? "");

          if (dest && entries.has(dest.uri)) {
            const next = clone(s);

            next.env.deletePrefix("local:");

            schedule(context, entries.get(dest.uri)!, next);
          }
        }

        if (/\ballow_no_selection\b/.test(line.args)) for (const next of node.next) schedule(context, next, s);

        continue;
      }

      if (c === "finish" || !node.next.length) {
        const index = orderedScenes.indexOf(documents.get(line.uri)!.scene),
          scene = scenes.get(orderedScenes[index + 1]);

        if (index >= 0 && scene && entries.has(scene.uri)) {
          s.env.deletePrefix("local:");

          schedule(context, entries.get(scene.uri)!, s);
        } else returnState(context, s);

        continue;
      }

      for (const next of node.next) schedule(context, next, s);
    }
  }

  processQueue();

  for (const doc of documents.values())
    if (!doc.lines.some((l) => observed.has(l.id)) && entries.has(doc.uri)) {
      schedule(
        "isolated:" + doc.uri,
        entries.get(doc.uri)!,
        options.incompleteProject ? { ...initial, quote: 7 } : initial,
      );
      processQueue();
    }

  // Propagation is finished. Keep only per-line observations while collecting
  // features; releasing flow/call snapshots prevents both phases from retaining
  // their peak allocations together in the bounded worker heap.
  states.clear();
  waiting.clear();
  effectCache.clear();
  nodes.clear();
  priorities.clear();
  featureExpressions.clear();
  const endings = [...summaries].map(([context, state]) => ({ context, quote: state.quote }));
  summaries.clear();

  for (const doc of documents.values()) {
    const all: Span[] = [],
      diagnostics = result.diagnostics.get(doc.uri)!;
    let words = 0;

    for (const line of doc.lines) {
      const state = (!result.truncated && observed.get(line.id)) || {
        quote: 7,
        paragraph: true,
        env: initial.env.empty(),
      };
      let base: Span[] = [];

      if (line.kind === "prose" || line.kind === "option" || line.inlineText !== undefined) {
        base = textTransfer(line, { ...state }, true);
        words += line.wordCount ?? narrativeWords(line.raw.slice(line.inlineText ?? line.indent));
      }

      if (
        !line.narrativeSummary &&
        options.quoteWarnings !== false &&
        state.quote !== 7 &&
        (state.quote & (state.quote - 1)) !== 0 &&
        line.kind === "prose"
      )
        diagnostics.push(
          diagnostic(
            line.line,
            line.indent,
            Math.max(1, line.raw.length - line.indent),
            "quote-branch",
            "Incoming paths disagree about whether dialogue is open.",
            2,
          ),
        );

      observed.delete(line.id);

      const overlays = line.tokens.map((t) => ({ ...t }));

      const sceneTarget = () => {
        if (line.targetExpr?.kind === "indirect") {
          const value = evaluate(line.targetExpr.expr, (name) => lookup(state, line.uri, name));
          return value.constant === undefined ? undefined : String(value.constant);
        }
        return line.target;
      };
      for (const t of overlays) {
        const spelling = line.raw.slice(t.start, t.start + t.length);
        const name = spelling.toLowerCase();

        if (t.type === "variable") {
          if (result.truncated && !t.modifiers?.includes("declaration")) {
            delete t.symbol;
            continue;
          }
          const directId = t.symbol ?? activeResolve(state, doc.uri, name);
          const alias =
            !result.symbols.has(directId) &&
            arrays.find(
              (a) =>
                (!a.local || a.uri === doc.uri) &&
                activeResolve(state, doc.uri, a.name) ===
                  (a.local ? "local:" + a.uri + ":" + a.name : "global:" + a.name) &&
                name.startsWith(a.name + "_") &&
                /^(?:\d+(?:_\d+)*|count)$/.test(name.slice(a.name.length + 1)),
            );
          const id = alias ? activeResolve(state, doc.uri, alias.name) : directId;
          t.symbol = id;
          if (alias) t.referenceLength = alias.name.length;

          let value = lookup(state, doc.uri, name);

          if (!result.truncated && t.modifiers?.includes("declaration") && line.expr)
            value = evaluate(line.expr, (n) => lookup(state, line.uri, n));

          if (line.raw[t.start + t.length] === "[") {
            const tail = line.raw.slice(t.start);
            const groups = valueGroups(lex(tail, line.line, t.start, []));
            value = evaluate(parseExpression(groups[0] ?? [], [], true), (n) => lookup(state, line.uri, n));
          }

          if (t.modifiers?.includes("declaration") && line.expr) {
            const v = evaluate(line.expr, (n) => lookup(state, line.uri, n));
            result.values.set(id, v);
          } else result.values.set(id, joinValue(result.values.get(id) ?? value, value));

          const type = value.types.length === 1 ? value.types[0] : undefined;

          if (type && type !== "unknown") t.type = type + "Variable";
        } else if (t.type === "label" && !t.symbol) {
          if (
            ["scene_list", "goto_random_scene"].includes(line.parent?.command ?? "") ||
            (line.command?.endsWith("_scene") && t.start === line.targetToken?.start)
          )
            t.symbol = "scene:" + spelling;
          else {
            let uri = doc.uri;

            if (line.command?.endsWith("_scene")) {
              const destination = scenes.get(sceneTarget() ?? "");
              if (!destination) continue;
              uri = destination.uri;
            }

            t.symbol = "label:" + uri + ":" + name;
          }
        }

        if (t.symbol) {
          const refs = result.references.get(t.symbol) ?? [];
          refs.push({
            uri: doc.uri,
            range: range(t.line, t.start, t.referenceLength ?? t.length),
          });
          result.references.set(t.symbol, refs);
        }
      }

      if (
        line.targetToken &&
        ["goto", "gosub", "goto_scene", "gosub_scene", "redirect_scene"].includes(line.command ?? "") &&
        line.targetToken.type === "label"
      ) {
        const c = line.command!,
          found = c.endsWith("_scene") ? scenes.has(line.target!) : labels.has(doc.uri + ":" + line.target);

        if (!found)
          diagnostics.push(
            diagnostic(
              line.line,
              line.targetToken.start,
              line.targetToken.length,
              "missing-target",
              `Unknown ${c.endsWith("_scene") ? "scene" : "label"} ${line.target}.`,
            ),
          );
      }

      // Overlay code and markup spans over prose without emitting overlapping LSP tokens.
      let bold = false,
        italic = false;
      let previousEnd = -1;
      const disjoint =
        !base.length &&
        overlays.every((token) => {
          if (token.start < previousEnd) return false;

          previousEnd = token.start + token.length;
          return true;
        });

      for (const t of disjoint ? overlays : overlaySegments(base, overlays)) {
        if (t.type === "markup") {
          const raw = line.raw.slice(t.start, t.start + t.length).toLowerCase();

          if (raw === "[b]") bold = true;
          if (raw === "[/b]") bold = false;
          if (raw === "[i]") italic = true;
          if (raw === "[/i]") italic = false;
        }

        if (bold || italic) {
          const modifiers = [...(t.modifiers ?? [])];

          if (t.type !== "markup") {
            if (bold) modifiers.push("bold");
            if (italic) modifiers.push("italic");
          }

          t.modifiers = modifiers;
        } else t.modifiers ??= [];

        all.push(t);
      }
    }

    const dedup = new Map(diagnostics.map((d) => [JSON.stringify(d), d]));
    result.diagnostics.set(doc.uri, [...dedup.values()]);
    result.tokens.set(doc.uri, all);
    result.wordCounts.set(doc.uri, words);
  }

  if (!result.truncated && options.quoteWarnings !== false)
    for (const { context, quote } of endings)
      if ((context === "root" || context.startsWith("isolated:")) && (quote === 2 || quote === 4)) {
        const doc = context === "root" ? start : documents.get(context.slice(9));

        if (doc) {
          const last = doc.lines.findLast((l) => l.kind === "prose");

          if (last) {
            const location = last.narrativeSummary?.lastProse ?? {
              line: last.line,
              indent: last.indent,
              length: last.raw.length - last.indent,
            };
            result.diagnostics
              .get(doc.uri)!
              .push(
                diagnostic(
                  location.line,
                  location.indent,
                  Math.max(1, location.length),
                  "quote-unclosed",
                  "Dialogue is still open at the end of a resolved story path.",
                  2,
                ),
              );
          }
        }
      }

  return result;
}
