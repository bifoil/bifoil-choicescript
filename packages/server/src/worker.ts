import { parentPort } from "node:worker_threads";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { deflateSync, inflateSync } from "node:zlib";
import { analyzeProject, type Document, parseDocument, projectDocument } from "@bifoil/choicescript-core";
import { sameFileUri } from "@bifoil/choicescript-tooling";
import type { BufferSnapshot } from "@bifoil/choicescript-protocol";
import type { IndexedSource } from "./scene-index.js";
import { type FeatureCache, packAnalysis, snapshotBuffers } from "./snapshots.js";
const parsedCache = new Map<string, { stamp?: number; version: number; full: boolean; doc: Document }>();
const featureCache: FeatureCache = new Map();
parentPort!.on(
  "message",
  async ({
    mode,
    sources = [],
    directory,
    documents = [],
    options = {},
  }: {
    mode?: "index";
    sources?: IndexedSource[];
    directory?: string;
    documents?: BufferSnapshot[];
    options?: Parameters<typeof analyzeProject>[1];
  }) => {
    try {
      if (mode === "index") {
        for (const source of sources) {
          try {
            const before = await lstat(source.file, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink()) throw new Error("Scene must be a regular file.");
            const text = await readFile(source.file, "utf8");
            const after = await lstat(source.file, { bigint: true });
            if (
              before.ino !== after.ino ||
              before.size !== after.size ||
              before.mtimeNs !== after.mtimeNs ||
              before.ctimeNs !== after.ctimeNs
            )
              throw new Error("Scene changed while indexing; retry after saving.");
            const document = projectDocument(parseDocument(source.uri, text));
            const cache = path.join(directory!, createHash("sha256").update(source.uri).digest("hex") + ".bin");
            const temporary = cache + ".tmp";
            const data = Uint8Array.from(deflateSync(serialize(document), { level: 1 }));
            await writeFile(temporary, data);
            await rename(temporary, cache);
            parentPort!.postMessage({ indexed: { uri: source.uri, cache, data } }, [data.buffer]);
          } catch (error) {
            parentPort!.postMessage({ indexError: { uri: source.uri, error: String(error) } });
          }
        }
        parentPort!.postMessage({ done: true });
        return;
      }
      const started = performance.now();
      const parsed: Document[] = [];
      let incomplete = false;
      for (const source of sources) {
        const buffer = documents.find((document) => sameFileUri(document.uri, source.uri));
        if (buffer) {
          const previous = parsedCache.get(buffer.uri);
          const doc =
            previous?.full && previous.version === buffer.version && previous.doc.text === buffer.text
              ? previous.doc
              : parseDocument(buffer.uri, buffer.text, buffer.version);
          parsedCache.set(buffer.uri, { stamp: source.stamp, version: buffer.version, full: true, doc });
          parsed.push(doc);
          continue;
        }
        const previous = parsedCache.get(source.uri);
        if (previous && previous.stamp === source.stamp && previous.version <= 0 && (!source.full || previous.full)) {
          if (previous.full && !source.full) {
            projectDocument(previous.doc);
            previous.full = false;
          }
          parsed.push(previous.doc);
          continue;
        }
        if (source.full) {
          const doc = parseDocument(source.uri, await readFile(source.file, "utf8"), -(source.stamp ?? 0));
          parsedCache.set(source.uri, { stamp: source.stamp, version: doc.version, full: true, doc });
          parsed.push(doc);
          continue;
        }
        if (source.cache) {
          const doc: Document = deserialize(inflateSync(source.data ?? (await readFile(source.cache))));
          doc.version = -(source.stamp ?? 0);
          parsedCache.set(source.uri, { stamp: source.stamp, version: doc.version, full: false, doc });
          parsed.push(doc);
          continue;
        }
        // Catalogue identities are known before their code is indexed.
        const placeholder = parseDocument(source.uri, "");
        placeholder.roots = [];
        placeholder.lines = [];
        placeholder.compact = true;
        placeholder.lineCount = 1;
        placeholder.endCharacter = 0;
        parsed.push(placeholder);
        incomplete = true;
      }
      for (const buffer of documents)
        if (!sources.some((source) => sameFileUri(buffer.uri, source.uri)))
          parsed.push(parseDocument(buffer.uri, buffer.text, buffer.version));
      const included = new Set(parsed.map((doc) => doc.uri));
      for (const uri of parsedCache.keys()) if (!included.has(uri)) parsedCache.delete(uri);
      const loaded = performance.now();
      const analysis = analyzeProject(parsed, {
        ...options,
        incompleteProject: incomplete,
        quoteWarnings: incomplete ? false : options.quoteWarnings,
      });
      if (incomplete) {
        for (const [uri, diagnostics] of analysis.diagnostics)
          analysis.diagnostics.set(
            uri,
            diagnostics.filter((d) => d.code !== "missing-target"),
          );
      }
      const analyzed = performance.now();
      const snapshot = packAnalysis(analysis, false, featureCache, true);
      if (process.env.BIFOIL_CHOICESCRIPT_PROFILE === "1")
        console.error(
          "BIFOIL_ANALYSIS_PROFILE " +
            JSON.stringify({
              loadMs: loaded - started,
              analyzeMs: analyzed - loaded,
              packMs: performance.now() - analyzed,
              documents: parsed.length,
              heapMiB: process.memoryUsage().heapUsed / 1024 / 1024,
              featureCacheSize: featureCache.size,
            }),
        );
      snapshot.incomplete = incomplete;
      parentPort!.postMessage({ snapshot }, snapshotBuffers(snapshot));
    } catch (error) {
      parentPort!.postMessage({ error: String(error) });
    }
  },
);
