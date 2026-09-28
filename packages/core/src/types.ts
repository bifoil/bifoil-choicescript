export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Span {
  line: number;
  start: number;
  length: number;
  type: string;
  modifiers?: string[];
  symbol?: string;
  referenceLength?: number;
}
export interface Diagnostic {
  range: Range;
  message: string;
  code: string;
  severity: 1 | 2 | 3;
  source: string;
}
export type ValueType = "number" | "string" | "boolean" | "unknown";
export interface Value {
  types: ValueType[];
  constant?: string | number | boolean;
}
export type Expr =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "variable"; name: string; token: Span }
  | { kind: "indirect"; expr: Expr }
  | { kind: "array"; name: string; indexes: Expr[]; token: Span }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "unknown" };
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
}
export interface Document {
  uri: string;
  text: string;
  version: number;
  lines: Line[];
  roots: Line[];
  diagnostics: Diagnostic[];
  scene: string;
}
export interface SymbolInfo {
  id: string;
  name: string;
  kind: "global" | "local" | "label" | "scene";
  uri: string;
  range: Range;
}
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
export const tokenModifiers = ["declaration", "readonly", "bold", "italic"];
export const unknown = (): Value => ({ types: ["unknown"] });
export function range(line: number, start: number, length: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: start + length },
  };
}
export function diagnostic(
  line: number,
  start: number,
  length: number,
  code: string,
  message: string,
  severity: 1 | 2 | 3 = 1,
): Diagnostic {
  return {
    range: range(line, start, Math.max(1, length)),
    message,
    code,
    severity,
    source: code.startsWith("quote-") ? "ChoiceScript dialogue" : "ChoiceScript",
  };
}
export function sceneName(uri: string): string {
  return decodeURIComponent(uri.split("/").pop() ?? "")
    .replace(/\.txt$/i, "")
    .toLowerCase();
}
export const literal = (constant: string | number | boolean): Value => ({
  types: [typeof constant as ValueType],
  constant,
});
export function joinValue(a: Value, b: Value): Value {
  const types = [...new Set([...a.types, ...b.types])].sort() as ValueType[];
  return {
    types,
    ...(a.constant !== undefined && a.constant === b.constant ? { constant: a.constant } : {}),
  };
}
