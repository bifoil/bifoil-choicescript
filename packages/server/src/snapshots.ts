import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { deflateSync, inflateSync } from "node:zlib";
import {
  type Analysis,
  type Document,
  encodeTokens,
  folding,
  type Line,
  type Position,
  type Span,
  tokenTypes,
} from "@bifoil/choicescript-core";

type FeatureLine = Pick<Line, "line" | "raw" | "kind" | "command" | "targetToken">;
type Chunk = { lines: FeatureLine[]; tokens: Span[] };

/**
 * Request-oriented document index, not a recoverable syntax tree.
 * Full scenes are chunked by 256 physical lines; compact scenes use a single sparse chunk.
 * Headers retain array/parameter collision context even when other lines are not decoded.
 */
type FeatureDocument = {
  version: number;
  lineCount: number;
  headers: FeatureLine[];
  last: FeatureLine;
  chunks: Map<number, Uint8Array>;
  compact: boolean;
  folding: ReturnType<typeof folding>;
  tokens: Uint8Array;
};

const chunkSize = 256;

const encode = (value: unknown): Uint8Array => {
  const compressed = deflateSync(serialize(value), { level: 1 });
  // Own the buffer so worker transfer never detaches a pooled slab.
  const data = new Uint8Array(compressed.length);
  data.set(compressed);

  return data;
};

const decode = <T>(data: Uint8Array): T => deserialize(inflateSync(data));

/**
 * Worker-to-server result with compressed per-request data and source version stamps.
 * data is optional full syntax for noninteractive consumers. A delta may omit unchanged
 * features and name them in reuseFeatures; merge it against the accepted predecessor
 * before serving requests. This is a private same-build V8 serialization format, not LSP.
 */
export interface AnalysisSnapshot {
  reuseFeatures?: string[];
  incomplete?: boolean;
  data?: Uint8Array;
  documents: Map<string, { version: number }>;
  diagnostics: Analysis["diagnostics"];
  symbols: Analysis["symbols"];
  values: Analysis["values"];
  references: Uint8Array;
  features: Map<string, FeatureDocument>;
  wordCounts: Analysis["wordCounts"];
  truncated: boolean;
}

/**
 * Worker-owned copies of feature data keyed by content/version/token fingerprints.
 * Copies must survive postMessage transfer detaching the buffers in an emitted snapshot.
 */
export type FeatureCache = Map<string, { signature: string; feature: FeatureDocument }>;

/**
 * Build compressed request indexes and optionally serialize the complete analysis.
 * When includeSyntaxTree is true, line URI fields are temporarily removed and restored
 * to reduce duplication; callers must not read/mutate the analysis concurrently.
 * delta requires a matching predecessor on the receiving side. Uncompressed result maps
 * are borrowed until structured-cloned across the worker boundary.
 */
export function packAnalysis(
  analysis: Analysis,
  includeSyntaxTree = true,
  cache?: FeatureCache,
  delta = false,
): AnalysisSnapshot {
  const features = new Map<string, FeatureDocument>();
  const signatures = new Map<string, string>();
  const reuseFeatures: string[] = [];

  const featureLine = (line: Line): FeatureLine => ({
    line: line.line,
    raw: line.raw,
    kind: line.kind,
    command: line.command,
    targetToken: line.targetToken,
  });

  const fingerprint = (doc: Document, tokens: Span[]) => {
    // Hash bounded batches: a whole-array JSON string can be larger than the
    // source and its AST together when many tokens repeat long symbol URIs.
    const hash = createHash("sha256");
    for (let start = 0; start < tokens.length; start += 256)
      hash.update(JSON.stringify(tokens.slice(start, start + 256))).update("\n");
    return (
      doc.version +
      ":" +
      (doc.compact ? "compact" : createHash("sha256").update(doc.text).digest("base64")) +
      ":" +
      hash.digest("base64")
    );
  };

  for (const doc of analysis.documents.values()) {
    const tokens = analysis.tokens.get(doc.uri) ?? [];
    const signature = cache ? fingerprint(doc, tokens) : "";

    if (cache) signatures.set(doc.uri, signature);

    const previous = cache?.get(doc.uri);

    if (previous?.signature === signature) {
      if (delta) reuseFeatures.push(doc.uri);
      else features.set(doc.uri, structuredClone(previous.feature));

      continue;
    }

    const grouped = new Map<number, Chunk>();

    const group = (row: number) => {
      const index = doc.compact ? 0 : Math.floor(row / chunkSize);
      let chunk = grouped.get(index);

      if (!chunk) {
        chunk = { lines: [], tokens: [] };
        grouped.set(index, chunk);
      }

      return chunk;
    };

    for (const line of doc.lines) group(line.line).lines.push(featureLine(line));
    for (const token of tokens) group(token.line).tokens.push(token);

    const chunks = new Map([...grouped].map(([index, chunk]) => [index, encode(chunk)]));
    features.set(doc.uri, {
      version: doc.version,
      lineCount: doc.lineCount ?? doc.lines.length,
      compact: doc.compact ?? false,
      headers: doc.lines
        .filter((line) => ["create_array", "temp_array", "params"].includes(line.command ?? ""))
        .map(featureLine),
      last: {
        ...featureLine(doc.lines.at(-1) ?? ({ line: 0, raw: "", kind: "blank" } as Line)),
        line: (doc.lineCount ?? doc.lines.length) - 1,
        raw: " ".repeat(doc.endCharacter ?? doc.lines.at(-1)?.raw.length ?? 0),
      },
      chunks,
      folding: folding(analysis, doc.uri),
      tokens: encode(encodeTokens(analysis, doc.uri)),
    });
  }

  if (cache) {
    for (const uri of cache.keys()) if (!analysis.documents.has(uri)) cache.delete(uri);

    for (const [uri, feature] of features) {
      const signature = signatures.get(uri)!;

      if (cache.get(uri)?.signature !== signature) cache.set(uri, { signature, feature: structuredClone(feature) });
    }
  }

  // The live server needs the request indexes only. Other consumers may retain the complete tree.
  let data: Uint8Array | undefined;

  if (includeSyntaxTree) {
    for (const document of analysis.documents.values())
      for (const line of document.lines) delete (line as Partial<typeof line>).uri;

    try {
      data = encode(analysis);
    } finally {
      for (const document of analysis.documents.values()) for (const line of document.lines) line.uri = document.uri;
    }
  }

  return {
    ...(delta ? { reuseFeatures } : {}),
    data,
    documents: new Map([...analysis.documents].map(([uri, document]) => [uri, { version: document.version }])),
    diagnostics: analysis.diagnostics,
    symbols: analysis.symbols,
    values: analysis.values,
    references: encode(analysis.references),
    features,
    wordCounts: analysis.wordCounts,
    truncated: analysis.truncated,
  };
}

/**
 * List owned ArrayBuffers to transfer with a snapshot. postMessage detaches these on
 * the sender; do not reuse the emitted snapshot as the worker's cache.
 */
export function snapshotBuffers(snapshot: AnalysisSnapshot): ArrayBuffer[] {
  return [
    ...(snapshot.data ? [snapshot.data] : []),
    snapshot.references,
    ...[...snapshot.features.values()].flatMap((doc) => [doc.tokens, ...doc.chunks.values()]),
  ].map((data) => data.buffer as ArrayBuffer);
}

/**
 * Decode a full-tree snapshot and restore line URIs; throws for request-only snapshots without data.
 */
export function unpackAnalysis(snapshot: AnalysisSnapshot): Analysis {
  if (!snapshot.data) throw new Error("This request snapshot does not contain a syntax tree.");

  const analysis: Analysis = decode(snapshot.data);

  for (const document of analysis.documents.values()) for (const line of document.lines) line.uri = document.uri;

  return analysis;
}

/**
 * Materialize only chunks containing requested positions for one source URI.
 * withReferences additionally decodes the reference table and other documents' rename
 * headers. The result is a feature-query facade, not a complete AST: do not reanalyze
 * it or use it to compute folding/tokens for omitted lines.
 */
export function requestAnalysis(
  snapshot: AnalysisSnapshot,
  uri: string,
  positions: Position[] = [],
  withReferences = false,
): Analysis {
  const documents: Analysis["documents"] = new Map();
  const tokens: Analysis["tokens"] = new Map();

  const line = (source: FeatureLine): Line => ({
    ...source,
    id: "",
    uri,
    indent: 0,
    args: "",
    argStart: 0,
    children: [],
    tokens: [],
  });

  for (const [sourceUri, feature] of snapshot.features) {
    if (!withReferences && sourceUri !== uri) continue;

    const rows = new Map<number, Line>();

    for (const header of feature.headers) rows.set(header.line, { ...line(header), uri: sourceUri });

    rows.set(feature.last.line, { ...line(feature.last), uri: sourceUri });

    const lines = [...rows.values()].sort((a, b) => a.line - b.line);
    documents.set(sourceUri, {
      uri: sourceUri,
      text: "",
      version: feature.version,
      scene: "",
      lineCount: feature.lineCount,
      endCharacter: feature.last.raw.length,
      compact: true,
      lines,
      roots: [],
      diagnostics: [],
    });
  }

  const feature = snapshot.features.get(uri);

  if (feature) {
    const selected = new Set(
      positions
        .filter((p) => p.line >= 0 && p.line < feature.lineCount)
        .map((p) => (feature.compact ? 0 : Math.floor(p.line / chunkSize))),
    );
    const spans: Span[] = [];

    for (const index of [...selected].sort((a, b) => a - b)) {
      const encoded = feature.chunks.get(index);

      if (!encoded) continue;

      const chunk: Chunk = decode(encoded);
      const doc = documents.get(uri)!;
      const rows = new Map(doc.lines.map((l) => [l.line, l]));

      for (const source of chunk.lines) rows.set(source.line, line(source));

      doc.lines = [...rows.values()].sort((a, b) => a.line - b.line);
      spans.push(...chunk.tokens);
    }

    tokens.set(uri, spans);
  }

  return {
    documents,
    tokens,
    diagnostics: snapshot.diagnostics,
    symbols: snapshot.symbols,
    references: withReferences ? decode(snapshot.references) : new Map(),
    values: snapshot.values,
    wordCounts: snapshot.wordCounts,
    truncated: snapshot.truncated,
  };
}

/**
 * Decode the precomputed full semantic-token response without materializing source chunks.
 */
export function snapshotTokens(snapshot: AnalysisSnapshot, uri: string): ReturnType<typeof encodeTokens> {
  const feature = snapshot.features.get(uri);
  return feature ? decode(feature.tokens) : { data: [] };
}

/**
 * Read precomputed folds; sparse feature-query documents cannot reconstruct the original child tree.
 */
export function snapshotFolding(snapshot: AnalysisSnapshot, uri: string): ReturnType<typeof folding> {
  return snapshot.features.get(uri)?.folding ?? [];
}

/**
 * Update request indexes for one semantics-preserving prose edit or appended root comment.
 * Prose edits require unchanged indentation/line count and exclude quotes, commands, substitutions,
 * and markup. Returns undefined when full analysis is needed; never force this fast path.
 * A text-identical version bump is accepted, so callers measuring edits must exclude no-ops.
 * Returns new affected maps/chunks while borrowing untouched snapshot data.
 */
export function updatePlainProse(
  snapshot: AnalysisSnapshot,
  uri: string,
  before: string,
  after: string,
  previousVersion: number,
  version: number,
): AnalysisSnapshot | undefined {
  const feature = snapshot.features.get(uri);

  if (snapshot.data || !feature || feature.version !== previousVersion) return undefined;

  const oldLines = before.split(/\r\n|\n|\r/),
    newLines = after.split(/\r\n|\n|\r/);

  if (oldLines.length !== feature.lineCount) return undefined;

  // Appending a single root comment changes no existing source position or flow
  // state. In particular it must not insert an extra blank line that changes
  // continued-dialogue state at a scene's EOF.
  const suffix = after.startsWith(before) ? after.slice(before.length) : "";
  if (!feature.compact && newLines.length === oldLines.length + 1 && /^\r?\n\*comment\b[^\r\n]*$/i.test(suffix)) {
    const row = oldLines.length,
      raw = newLines[row];
    const comment: FeatureLine = { line: row, raw, kind: "comment", command: "comment", targetToken: undefined };
    const span: Span = { line: row, start: 0, length: raw.length, type: "comment", modifiers: [] };
    const index = Math.floor(row / chunkSize);
    const chunks = new Map(feature.chunks);
    const chunk = chunks.has(index) ? decode<Chunk>(chunks.get(index)!) : { lines: [], tokens: [] };
    chunk.lines.push(comment);
    chunk.tokens.push(span);
    chunks.set(index, encode(chunk));
    const tokens = snapshotTokens(snapshot, uri);
    let lastRow = 0;
    for (let i = 0; i < tokens.data.length; i += 5) lastRow += tokens.data[i];
    tokens.data.push(row - lastRow, 0, raw.length, tokenTypes.indexOf("comment"), 0);
    return {
      ...snapshot,
      documents: new Map(snapshot.documents).set(uri, { version }),
      features: new Map(snapshot.features).set(uri, {
        ...feature,
        version,
        lineCount: newLines.length,
        last: { ...comment, raw: " ".repeat(raw.length) },
        chunks,
        tokens: encode(tokens),
      }),
    };
  }

  if (newLines.length !== oldLines.length) return undefined;

  let changed = -1;

  for (let i = 0; i < oldLines.length; i++)
    if (oldLines[i] !== newLines[i]) {
      if (changed >= 0) return undefined;

      changed = i;
    }

  let updated = { ...feature, version };
  const diagnostics = new Map(snapshot.diagnostics),
    wordCounts = new Map(snapshot.wordCounts);

  if (changed >= 0) {
    const oldRaw = oldLines[changed],
      raw = newLines[changed];
    const indent = /^[ \t]*/.exec(oldRaw)![0],
      nextIndent = /^[ \t]*/.exec(raw)![0];

    if (
      indent !== nextIndent ||
      !raw.slice(indent.length) ||
      /^[*#]/.test(raw.slice(indent.length)) ||
      /["“”$@\[]/.test(oldRaw) ||
      /["“”$@\[]/.test(raw)
    )
      return undefined;

    const index = Math.floor(changed / chunkSize),
      encoded = feature.chunks.get(index);

    if (!encoded) return undefined;

    const chunk = decode<Chunk>(encoded);
    const line = chunk.lines.find((line) => line.line === changed);
    const spans = chunk.tokens.filter((span) => span.line === changed);

    if (
      !line ||
      line.raw !== oldRaw ||
      line.kind !== "prose" ||
      spans.length !== 1 ||
      !["narrative", "dialogue"].includes(spans[0].type) ||
      spans[0].start !== indent.length ||
      spans[0].length !== oldRaw.length - indent.length
    )
      return undefined;

    const span = spans[0],
      tokens = snapshotTokens(snapshot, uri);
    let row = 0,
      column = 0,
      found = false;

    for (let i = 0; i < tokens.data.length; i += 5) {
      const delta = tokens.data[i];
      row += delta;
      column = delta === 0 ? column + tokens.data[i + 1] : tokens.data[i + 1];

      if (row === changed && column === span.start && tokens.data[i + 2] === span.length) {
        tokens.data[i + 2] = raw.length - indent.length;
        found = true;
        break;
      }
    }

    if (!found) return undefined;

    line.raw = raw;
    span.length = raw.length - indent.length;

    const chunks = new Map(feature.chunks);
    chunks.set(index, encode(chunk));
    updated = {
      ...updated,
      chunks,
      tokens: encode(tokens),
      last: feature.last.line === changed ? { ...feature.last, raw } : feature.last,
    };

    const words = (text: string) => (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []).length;

    wordCounts.set(
      uri,
      (wordCounts.get(uri) ?? 0) + words(raw.slice(indent.length)) - words(oldRaw.slice(indent.length)),
    );
    diagnostics.set(
      uri,
      (diagnostics.get(uri) ?? []).map((d) =>
        d.range.start.line === changed && ["quote-branch", "quote-unclosed"].includes(d.code)
          ? { ...d, range: { start: { ...d.range.start }, end: { line: changed, character: raw.length } } }
          : d,
      ),
    );
  }

  return {
    ...snapshot,
    documents: new Map(snapshot.documents).set(uri, { version }),
    features: new Map(snapshot.features).set(uri, updated),
    diagnostics,
    wordCounts,
  };
}

/**
 * Resolve a worker delta against the previously accepted feature map.
 * Every next document needs a matching-version feature. Missing/mismatched reused data
 * throws instead of quietly publishing stale source locations. Removes the delta marker.
 */
export function mergeSnapshot(previous: AnalysisSnapshot | undefined, next: AnalysisSnapshot): AnalysisSnapshot {
  if (!next.reuseFeatures) return next;

  const reused = new Set(next.reuseFeatures),
    features = new Map<string, FeatureDocument>();

  for (const [uri, document] of next.documents) {
    const feature = next.features.get(uri) ?? (reused.has(uri) ? previous?.features.get(uri) : undefined);

    if (!feature || feature.version !== document.version)
      throw new Error("A current request index is missing from the worker snapshot.");

    features.set(uri, feature);
  }

  const merged = { ...next, features };
  delete merged.reuseFeatures;

  return merged;
}
