/**
 * LSP-compatible position: both fields are zero-based; character counts UTF-16 code units, not code points.
 */
export interface Position {
  line: number;
  character: number;
}

/**
 * Half-open source interval [start, end). End positions may equal the end of a physical line.
 */
export interface Range {
  start: Position;
  end: Position;
}

/**
 * Single-line semantic span in original source coordinates.
 * `symbol` is an analysis symbol ID, not a name to resolve again from prose.
 * `referenceLength` can be shorter than the colored span when only a base identifier
 * should participate in navigation or rename (for example, a generated array reference).
 */
export interface Span {
  line: number;
  start: number;
  length: number;
  type: string;
  modifiers?: string[];
  symbol?: string;
  referenceLength?: number;
}

/**
 * Editor-independent diagnostic. Severity uses LSP values (1 error, 2 warning, 3 information).
 */
export interface Diagnostic {
  range: Range;
  message: string;
  code: string;
  severity: 1 | 2 | 3;
  source: string;
}

export type ValueType = "number" | "string" | "boolean" | "unknown";

/**
 * Abstract value, never a live interpreter value.
 * `types` is a canonical ordered set at joins; `constant` is retained only when known.
 * Treat instances and their type arrays as immutable: environments share their values.
 */
export interface Value {
  readonly types: readonly ValueType[];
  readonly constant?: string | number | boolean;
}

/**
 * Recoverable expression tree. Unknown nodes preserve the surrounding structure after
 * incomplete input; consumers must propagate uncertainty rather than execute source text.
 */
export type Expr =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "variable"; name: string; token: Span }
  | { kind: "indirect"; expr: Expr }
  | { kind: "array"; name: string; indexes: Expr[]; token: Span }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "unknown" };

/**
 * Transfer table for a collapsed run of closed-scene prose.
 * For incoming quote masks 1..7 and paragraph flags false/true, table index is
 * `(mask - 1) * 2 + Number(paragraph)`. Quote bits are outside=1, straight=2, curly=4;
 * 7 denotes unknown. Parallel arrays record exits and possible warning locations.
 * `identity` is the cheaper quote-free case; it still updates paragraph state.
 * Coordinates refer to original prose, which is no longer retained in a compact document.
 */
export interface NarrativeSummary {
  identity?: { paragraph: boolean; range?: Range };
  quotes: number[];
  paragraphs: boolean[];
  unexpectedClose: Array<{ at: Position; count: number } | undefined>;
  disagreements: Array<Range | undefined>;
  lastProse?: { line: number; indent: number; length: number };
}

/**
 * An indentation-tree node, or a projected node covering several original source lines.
 * `line`, `indent`, `argStart` and token offsets use original UTF-16 coordinates.
 * `id` is reassigned per analysis; do not persist it as a source identity.
 * `parent` and `children` form cycles. For projected prose, `raw` is only a placeholder,
 * `endLine` is inclusive, and `narrativeSummary`/`wordCount` carry the removed text's data.
 */
export interface Line {
  id: string;
  uri: string;
  line: number;
  raw: string;
  indent: number;
  kind: "blank" | "comment" | "command" | "prose" | "option" | "metadata";
  command?: string;
  args: string;
  argStart: number;
  children: Line[];
  parent?: Line;
  tokens: Span[];
  expr?: Expr;
  expressions?: Expr[];
  target?: string;
  targetToken?: Span;
  targetExpr?: Expr;
  inlineText?: number;
  narrativeSummary?: NarrativeSummary;
  wordCount?: number;
  endLine?: number;
}

/**
 * Mutable parsed source shared with analysis.
 * Full documents retain text and physical rows. A compact projection clears `text`,
 * makes `lines` sparse, and preserves original extent in `lineCount`/`endCharacter`.
 * Use `lineAt` for exact source-row lookup; array indexing is not a source-position API.
 */
export interface Document {
  uri: string;
  text: string;
  version: number;
  lines: Line[];
  roots: Line[];
  diagnostics: Diagnostic[];
  scene: string;
  lineCount?: number;
  endCharacter?: number;
  compact?: boolean;
}

/**
 * Declaration identity and source location. Symbol IDs are separate from compact internal environment/graph keys.
 */
export interface SymbolInfo {
  id: string;
  name: string;
  kind: "global" | "local" | "label" | "scene";
  uri: string;
  range: Range;
}

/**
 * Project-wide result; document-keyed maps use source URIs, symbol maps use symbol IDs.
 * `values` aggregates information for a symbol; a reference's flow-sensitive type is
 * encoded on its semantic span. `truncated` means the work budget was exceeded,
 * so this result must not be advertised as complete-project analysis.
 */
export interface Analysis {
  documents: Map<string, Document>;
  tokens: Map<string, Span[]>;
  diagnostics: Map<string, Diagnostic[]>;
  symbols: Map<string, SymbolInfo>;
  references: Map<string, { uri: string; range: Range }[]>;
  values: Map<string, Value>;
  wordCounts: Map<string, number>;
  truncated: boolean;
}

/**
 * Ordered LSP legend. Changing this order changes token indices; keep both adapters and encoded snapshots aligned.
 */
export const tokenTypes = [
  "keyword",
  "comment",
  "string",
  "number",
  "operator",
  "variable",
  "function",
  "label",
  "boolean",
  "dialogue",
  "narrative",
  "stringVariable",
  "numberVariable",
  "booleanVariable",
  "markup",
  "interpolation",
];

/**
 * Ordered bit positions for LSP semantic-token modifiers, shared with both editor adapters.
 */
export const tokenModifiers = ["declaration", "readonly", "bold", "italic"];

/**
 * Create a fresh unknown abstract value; no mutable type array is shared between calls.
 */
export const unknown = (): Value => ({ types: ["unknown"] });

/**
 * Construct a single-line, end-exclusive range. Unlike diagnostic(), zero length is preserved.
 */
export function range(line: number, start: number, length: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: start + length },
  };
}

/**
 * Construct a diagnostic range; zero-width end-of-line anchors stay within the source.
 * Quote warnings use a separate source.
 */
export function diagnostic(
  line: number,
  start: number,
  length: number,
  code: string,
  message: string,
  severity: 1 | 2 | 3 = 1,
): Diagnostic {
  return {
    range: range(line, start, Math.max(0, length)),
    message,
    code,
    severity,
    source: code.startsWith("quote-") ? "ChoiceScript dialogue" : "ChoiceScript",
  };
}

/**
 * Decode the final URI segment as a case-preserving scene name, without a .txt suffix.
 */
export function sceneName(uri: string): string {
  return decodeURIComponent(uri.split("/").pop() ?? "").replace(/\.txt$/i, "");
}

/**
 * Wrap a known primitive without evaluating or expanding substitutions inside it.
 */
export const literal = (constant: string | number | boolean): Value => ({
  types: [typeof constant as ValueType],
  constant,
});

/**
 * Join possible types from two reachable paths. A constant survives only if both inputs
 * have the same known primitive; missing/unknown values must be supplied explicitly by callers.
 */
export function joinValue(a: Value, b: Value): Value {
  if (a === b) return a;
  const sameConstant = a.constant === b.constant;
  // Most fixed-point joins have already widened. Reuse a covering immutable value
  // instead of allocating and sorting the same tiny type set for every binding.
  if ((a.constant === undefined || sameConstant) && b.types.every((type) => a.types.includes(type))) return a;
  if ((b.constant === undefined || sameConstant) && a.types.every((type) => b.types.includes(type))) return b;
  const types = [...new Set([...a.types, ...b.types])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    types,
    ...(a.constant !== undefined && sameConstant ? { constant: a.constant } : {}),
  };
}

/**
 * Find an exact physical row in a sorted, possibly sparse document.
 * Returns undefined for an omitted row; it does not expand a prose summary covering that row.
 */
export function lineAt(document: Document | undefined, line: number): Line | undefined {
  if (!document) return undefined;

  let low = 0,
    high = document.lines.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1,
      candidate = document.lines[mid];

    if (candidate.line === line) return candidate;
    if (candidate.line < line) low = mid + 1;
    else high = mid - 1;
  }

  return undefined;
}
