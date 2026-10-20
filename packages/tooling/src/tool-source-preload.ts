/**
 * Bounded compatibility loader for the pinned official headless tools. Their VM
 * scripts and interpreter remain byte-identical. Only scene I/O and optional
 * memo caches change; cache eviction recomputes results, never skips execution.
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SceneSources, SceneText, isSourceLineView } from "./scene-source.js";

interface HeadlessGlobals {
  slurpFile?: (name: string, throwOnError?: boolean) => unknown;
  slurpFileLines?: (name: string, throwOnError?: boolean) => string[];
  crc32?: (text: unknown, crc?: number) => number;
  [key: string]: unknown;
}

/** Cache values are pinned runtime metadata, expression tokens, or sparse views. */
function cacheCost(value: unknown, seen: Set<object>, remaining: number): number {
  if (remaining <= 0) return Infinity;
  if (typeof value === "string") return 32 + value.length * 2;
  if (value === null || typeof value !== "object") return 16;
  if (isSourceLineView(value)) return 256;
  if (seen.has(value)) return 0;
  seen.add(value);
  let cost = 64;
  for (const key of Object.keys(value)) {
    cost += key.length * 2 + 16;
    cost += cacheCost((value as Record<string, unknown>)[key], seen, remaining - cost);
    if (cost > remaining) return Infinity;
  }
  return cost;
}

function boundedMemo(limit: number): object {
  const entries = new Map<string, { value: unknown; bytes: number }>();
  let bytes = 0;
  const own = (key: string) => key !== "hasOwnProperty" && entries.has(key);
  const store = (key: string, value: unknown): void => {
    const prior = entries.get(key);
    if (prior) {
      entries.delete(key);
      bytes -= prior.bytes;
    }
    const cost = 64 + key.length * 2 + cacheCost(value, new Set(), limit);
    if (cost > limit) return;
    while (bytes + cost > limit || entries.size >= 4096) {
      const first = entries.keys().next().value;
      if (first === undefined) break;
      bytes -= entries.get(first)!.bytes;
      entries.delete(first);
    }
    entries.set(key, { value, bytes: cost });
    bytes += cost;
  };
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, key) {
      // The official tokenizer calls this method before accessing cache[str].
      // That spelling is simply not memoized, so it cannot replace the method.
      if (key === "hasOwnProperty") return own;
      if (typeof key !== "string") return undefined;
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(_target, key, value) {
      // A Proxy set trap must acknowledge writes, including values deliberately left uncached.
      if (typeof key === "string" && key !== "hasOwnProperty") store(key, value);
      return true;
    },
    has(_target, key) {
      return typeof key === "string" && own(key);
    },
    ownKeys() {
      return [...entries.keys()];
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== "string" || !entries.has(key)) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: entries.get(key)!.value };
    },
    deleteProperty(_target, key) {
      if (typeof key === "string") {
        const entry = entries.get(key);
        if (entry) {
          bytes -= entry.bytes;
          entries.delete(key);
        }
      }
      return true;
    },
  });
}

/** Install in an owned staged worker; the caller owns disposal and its directory. */
export function installToolSources(stage: string, globals = globalThis as unknown as HeadlessGlobals): () => void {
  const sources = new SceneSources(stage);
  const original = vm.runInThisContext;
  const originalExec = RegExp.prototype.exec;
  const originalTest = RegExp.prototype.test;
  const sourceExec = function (this: RegExp, value: string): RegExpExecArray | null {
    return (value as unknown) instanceof SceneText
      ? (value as unknown as SceneText).metadataMatch(this, originalExec)
      : originalExec.call(this, value);
  };
  const sourceTest = function (this: RegExp, value: string): boolean {
    return (value as unknown) instanceof SceneText
      ? (value as unknown as SceneText).metadataMatch(this, originalExec) !== null
      : originalTest.call(this, value);
  };
  RegExp.prototype.exec = sourceExec;
  RegExp.prototype.test = sourceTest;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const remember = (key: string) => {
    if (!descriptors.has(key)) descriptors.set(key, Object.getOwnPropertyDescriptor(globals, key));
  };
  let installed = false,
    closed = false;

  // These are performance-only caches. Their original assignments still reset
  // them; bounded replacement never changes a computed label or execution step.
  for (const name of ["parsedLines", "cachedNonBlankLines", "cachedTokenizedExpressions"]) {
    remember(name);
    let memo = boundedMemo(1024 * 1024);
    Object.defineProperty(globals, name, {
      configurable: true,
      enumerable: true,
      get: () => memo,
      set: () => {
        memo = boundedMemo(1024 * 1024);
      },
    });
  }

  const hook = ((code: string, options?: vm.RunningScriptOptions | string) => {
    const result = original.call(vm, code, options);
    const filename = typeof options === "string" ? options : options?.filename;
    if (installed || !filename || path.basename(filename) !== "headless.js") return result;
    installed = true;
    const text = globals.slurpFile;
    const lines = globals.slurpFileLines;
    const crc32 = globals.crc32;
    if (!text || !lines) throw new Error("Pinned headless source loaders are unavailable.");
    for (const key of ["slurpFile", "slurpFileLines", "crc32"]) remember(key);

    globals.slurpFile = (name, throwOnError) => {
      if (!sources.accepts(name)) return text(name, throwOnError);
      const source = sources.text(name);
      if (throwOnError) source.lines(true);
      return source;
    };
    globals.slurpFileLines = (name, throwOnError) =>
      sources.accepts(name) ? sources.text(name).lines(throwOnError) : lines(name, throwOnError);
    if (crc32)
      globals.crc32 = (value, initial) =>
        value instanceof SceneText ? value.crc32((line, crc) => crc32(line, crc), initial) : crc32(value, initial);
    return result;
  }) as typeof vm.runInThisContext;
  vm.runInThisContext = hook;

  return () => {
    if (closed) return;
    closed = true;
    if (vm.runInThisContext === hook) vm.runInThisContext = original;
    if (RegExp.prototype.exec === sourceExec) RegExp.prototype.exec = originalExec;
    if (RegExp.prototype.test === sourceTest) RegExp.prototype.test = originalTest;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globals, key, descriptor);
      else delete globals[key];
    }
    sources.dispose();
  };
}

// The generated preload is passed only to known official tool entry points.
// Plain imports expose the testable adapter without altering VM/global behavior.
const entry = process.argv[1] && path.basename(process.argv[1]);
if (entry && ["mygamegenerator.js", "randomtest.js", "quicktest.js", "autotest.js"].includes(entry)) {
  const marker = JSON.parse(readFileSync(path.join(process.cwd(), ".bifoil-tool-stage.json"), "utf8"));
  if (marker?.format !== 1) throw new Error("Tool source preload requires an owned staging directory.");
  const dispose = installToolSources(process.cwd());
  process.once("exit", dispose);
}
