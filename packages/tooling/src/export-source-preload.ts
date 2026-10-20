/**
 * Run the pinned compiler unchanged, spooling its scene JSON instead of retaining
 * every scene string in the assembled HTML. The compiler's own image transform,
 * CRC, label parsing, ASCII JSON, metadata and HTML assembly remain authoritative.
 * This entry point is used only in a disposable, runner-owned compile worker.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { installToolSources } from "./tool-source-preload.js";
import { isSourceLineView } from "./scene-source.js";

type Globals = typeof globalThis & { rootDir?: string; toJson?: (value: unknown, standardized?: boolean) => string };
const globals = globalThis as Globals;

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let at = 0; at < bytes.byteLength; ) {
    const count = fs.writeSync(fd, bytes, at, bytes.byteLength - at);
    if (!count) throw new Error("Could not write complete compiled source.");
    at += count;
  }
}

/** Opaque intermediate consumed only by the pinned compiler's following toJson call. */
class SpooledLines {
  constructor(readonly marker: string) {}
}

function installExport(stage: string): () => void {
  const output = path.resolve(process.argv[2] || "output.html");
  if (path.dirname(output) !== path.resolve(stage)) throw new Error("Compiled output must remain in its owned stage.");
  const owned = fs.mkdtempSync(path.join(stage, ".bifoil-export-"));
  const disposeSources = installToolSources(stage);
  const originalRun = vm.runInThisContext;
  const originalMap = Array.prototype.map;
  const originalWrite = fs.writeFileSync;
  const oldRoot = Object.getOwnPropertyDescriptor(globals, "rootDir");
  const oldJSON = Object.getOwnPropertyDescriptor(globals, "toJson");
  const scenes = new Map<string, string>();
  const serial = randomUUID().replaceAll("-", "");
  let originalJSON: Globals["toJson"];
  let closed = false;
  globals.rootDir = "web/";

  // Encoding repeated blank/markup/prose lines is pure. The official transform
  // still runs for every row; this small exact cache only reuses its JSON result.
  const encodedLines = new Map<string, string>();
  let encodedBytes = 0;
  const encode = (value: unknown): string => {
    if (typeof value !== "string") return originalJSON!(value);
    const known = encodedLines.get(value);
    if (known !== undefined) return known;
    const json = originalJSON!(value);
    const cost = 96 + 2 * (value.length + json.length);
    if (cost <= 256 * 1024) {
      while (encodedLines.size >= 64 || encodedBytes + cost > 256 * 1024) {
        const key = encodedLines.keys().next().value!;
        encodedBytes -= 96 + 2 * (key.length + encodedLines.get(key)!.length);
        encodedLines.delete(key);
      }
      encodedLines.set(value, json);
      encodedBytes += cost;
    }
    return json;
  };

  const spool = (
    lines: string[],
    transform?: (value: string, index: number, array: string[]) => unknown,
    thisArg?: unknown,
  ): SpooledLines => {
    if (!originalJSON) throw new Error("Pinned compiler JSON encoder is unavailable.");
    const marker = `BIFOIL_EXPORT_${serial}_${scenes.size}_END`;
    const file = path.join(owned, String(scenes.size) + ".json");
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      writeAll(fd, Buffer.from("["));
      let pending = "";
      for (let line = 0; line < lines.length; line++) {
        const value = transform ? transform.call(thisArg, lines[line], line, lines) : lines[line];
        pending += (line ? "," : "") + encode(value);
        if (pending.length >= 32 * 1024) {
          writeAll(fd, Buffer.from(pending, "utf8"));
          pending = "";
        }
      }
      writeAll(fd, Buffer.from(pending + "]", "utf8"));
    } finally {
      fs.closeSync(fd);
    }
    scenes.set(marker, file);
    return new SpooledLines(marker);
  };

  // The pinned compiler maps its own image-embedding callback over source lines,
  // immediately passing that result to toJson. Execute every callback once in
  // order and spool its exact JSON; other arrays keep the original map behavior.
  Array.prototype.map = function (
    this: unknown[],
    callback: (value: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    if (isSourceLineView(this)) return spool(this as string[], callback, thisArg);
    return originalMap.call(this, callback, thisArg);
  } as typeof Array.prototype.map;

  const hook = ((code: string, options?: vm.RunningScriptOptions | string) => {
    const result = originalRun.call(vm, code, options);
    const filename = typeof options === "string" ? options : options?.filename;
    if (filename && path.basename(filename) === "headless.js") {
      originalJSON = globals.toJson;
      if (!originalJSON) throw new Error("Pinned compiler JSON encoder is unavailable.");
      globals.toJson = (value, standardized) => {
        if (value instanceof SpooledLines) return value.marker;
        if (Array.isArray(value) && isSourceLineView(value)) return spool(value).marker;
        return originalJSON!(value, standardized);
      };
    }
    return result;
  }) as typeof vm.runInThisContext;
  vm.runInThisContext = hook;

  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
    if (typeof file !== "string" || path.resolve(file) !== output || typeof data !== "string")
      return originalWrite(file, data as string, options);
    const pattern = new RegExp(`BIFOIL_EXPORT_${serial}_[0-9]+_END`, "g");
    const seen = new Set<string>();
    const fd = fs.openSync(output, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let start = 0;
      for (let match; (match = pattern.exec(data)); ) {
        const source = scenes.get(match[0]);
        if (!source || seen.has(match[0])) throw new Error("Invalid compiled source placeholder.");
        seen.add(match[0]);
        writeAll(fd, Buffer.from(data.slice(start, match.index), "utf8"));
        const input = fs.openSync(source, "r");
        try {
          for (let count; (count = fs.readSync(input, buffer, 0, buffer.length, null)); )
            writeAll(fd, buffer.subarray(0, count));
        } finally {
          fs.closeSync(input);
        }
        start = pattern.lastIndex;
      }
      if (seen.size !== scenes.size) throw new Error("Compiled source placeholder was lost.");
      writeAll(fd, Buffer.from(data.slice(start), "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  }) as typeof fs.writeFileSync;

  return () => {
    if (closed) return;
    closed = true;
    vm.runInThisContext = originalRun;
    Array.prototype.map = originalMap;
    fs.writeFileSync = originalWrite;
    if (oldRoot) Object.defineProperty(globals, "rootDir", oldRoot);
    else Reflect.deleteProperty(globals, "rootDir");
    if (oldJSON) Object.defineProperty(globals, "toJson", oldJSON);
    else if (originalJSON) globals.toJson = originalJSON;
    else Reflect.deleteProperty(globals, "toJson");
    try {
      disposeSources();
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  };
}

if (path.basename(process.argv[1] || "") === "compile.js") {
  const stage = process.cwd();
  const marker = JSON.parse(fs.readFileSync(path.join(stage, ".bifoil-tool-stage.json"), "utf8"));
  if (marker?.format !== 1) throw new Error("Compile preload requires an owned staging directory.");
  const dispose = installExport(stage);
  process.once("exit", dispose);
}
