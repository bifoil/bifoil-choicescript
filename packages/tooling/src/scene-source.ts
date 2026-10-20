/**
 * Immutable file-backed scene inputs for the pinned headless tools. Source bytes
 * and line offsets live in an owned staging cache; shared page/decoded-line LRUs
 * bound retention independently of scene count and narrative word count.
 *
 * SceneText implements the exact source operations used by the pinned tools. It
 * is deliberately an internal adapter, not a general replacement for JS strings.
 */
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

class BudgetCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  constructor(
    private readonly limit: number,
    private readonly count: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    const prior = this.entries.get(key);
    if (prior) {
      this.entries.delete(key);
      this.bytes -= prior.bytes;
    }
    if (bytes > this.limit) return;

    while (this.bytes + bytes > this.limit || this.entries.size >= this.count) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.bytes -= this.entries.get(first)!.bytes;
      this.entries.delete(first);
    }

    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

interface Snapshot {
  id: number;
  source: string;
  offsets: string;
  bytes: number;
  lines: number;
  characters: number;
  digest: string;
  identity: string;
}

const lineViews = new WeakSet<object>();

/** Metadata-only estimate for upstream optional caches; never enumerate source lines. */
export function isSourceLineView(value: object): boolean {
  return lineViews.has(value);
}

const pageBytes = 64 * 1024;

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (!written) throw new Error("Could not preserve a complete tool source snapshot.");
    offset += written;
  }
}

/** Only this freshly created directory is eligible for recursive disposal. */
export class SceneSources {
  private readonly ownedDirectory: string;
  private readonly latest = new Map<string, Snapshot>();
  private readonly pages = new BudgetCache<Buffer>(2 * 1024 * 1024, 256);
  private readonly decoded = new BudgetCache<string>(2 * 1024 * 1024, 4096);
  private readonly descriptors = new Map<string, number>();
  // Sequential scans repeatedly touch the same index/source page. Keep only the
  // two most recent borrowed pages hot to avoid rebuilding LRU keys for every row.
  private hotPages: ({ identity: string; ordinal: number; buffer: Buffer } | undefined)[] = [];
  private lastLine: { snapshot: number; line: number; text: string } | undefined;
  private serial = 0;
  private closed = false;

  constructor(
    stage: string,
    readonly sceneDirectory = path.join(stage, "web/mygame/scenes"),
  ) {
    this.ownedDirectory = mkdtempSync(path.join(stage, ".bifoil-source-"));
  }

  accepts(file: string): boolean {
    const relative = path.relative(this.sceneDirectory, path.resolve(file));
    return (
      /\.txt$/i.test(file) && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
    );
  }

  text(file: string): SceneText {
    if (this.closed) throw new Error("Tool source storage is closed.");
    const absolute = path.resolve(file);
    if (!this.accepts(absolute)) throw new Error("Tool scene is outside its staged scene directory.");

    const before = lstatSync(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Tool scene must be a regular staged file.");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Tool scene exceeds safe file-offset precision.");
    const identity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
    const previous = this.latest.get(absolute);
    if (previous?.identity === identity) return new SceneText(this, previous, file);

    const id = ++this.serial;
    const source = path.join(this.ownedDirectory, `${id}.source`);
    const offsets = path.join(this.ownedDirectory, `${id}.offsets`);
    const input = openSync(absolute, "r");
    let output: number | undefined;
    let index: number | undefined;
    let accepted = false;

    try {
      output = openSync(source, "wx", 0o600);
      index = openSync(offsets, "wx", 0o600);
      const buffer = Buffer.allocUnsafe(256 * 1024);
      const entries = Buffer.allocUnsafe(64 * 1024);
      const decoder = new StringDecoder("utf8");
      const hash = createHash("sha256");
      let used = 0,
        bytes = 0,
        lines = 0,
        characters = 0;
      let first = true,
        trailingCR = false;

      const addOffset = (offset: number) => {
        if (used === entries.length) {
          writeAll(index!, entries);
          used = 0;
        }
        entries.writeBigUInt64LE(BigInt(offset), used);
        used += 8;
      };
      const normalized = (text: string, final: boolean) => {
        if (first && text.length) {
          first = false;
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        }
        if (trailingCR) text = "\r" + text;
        trailingCR = !final && text.endsWith("\r");
        if (trailingCR) text = text.slice(0, -1);
        text = text.replace(/\r\n/g, "\n");
        hash.update(text, "utf8");
        characters += text.length;
      };

      addOffset(0);
      while (true) {
        const count = readSync(input, buffer, 0, buffer.length, null);
        if (!count) break;
        const chunk = buffer.subarray(0, count);
        writeAll(output, chunk);
        normalized(decoder.write(chunk), false);
        for (let start = 0; start < count; ) {
          const newline = chunk.indexOf(10, start);
          if (newline < 0) break;
          addOffset(bytes + newline + 1);
          lines++;
          start = newline + 1;
        }
        bytes += count;
      }
      normalized(decoder.end(), true);
      addOffset(bytes);
      writeAll(index, entries.subarray(0, used));

      const after = fstatSync(input, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        BigInt(bytes) !== before.size
      )
        throw new Error("Staged scene changed while capturing the official tool's source.");

      const snapshot: Snapshot = {
        id,
        source,
        offsets,
        bytes,
        lines: lines + 1,
        characters,
        digest: hash.digest("hex"),
        identity,
      };
      this.latest.set(absolute, snapshot);
      accepted = true;
      return new SceneText(this, snapshot, file);
    } finally {
      closeSync(input);
      if (output !== undefined) closeSync(output);
      if (index !== undefined) closeSync(index);
      if (!accepted) {
        rmSync(source, { force: true });
        rmSync(offsets, { force: true });
      }
    }
  }

  private descriptor(file: string): number {
    const prior = this.descriptors.get(file);
    if (prior !== undefined) {
      this.descriptors.delete(file);
      this.descriptors.set(file, prior);
      return prior;
    }
    if (this.descriptors.size >= 16) {
      const first = this.descriptors.keys().next().value!;
      closeSync(this.descriptors.get(first)!);
      this.descriptors.delete(first);
    }
    const fd = openSync(file, "r");
    this.descriptors.set(file, fd);
    return fd;
  }

  private page(file: string, identity: string, position: number, size: number): Buffer {
    const ordinal = Math.floor(position / pageBytes);
    const slot = identity.endsWith("i") ? 0 : 1;
    const hot = this.hotPages[slot];
    if (hot?.identity === identity && hot.ordinal === ordinal) return hot.buffer;
    const key = `${identity}:${ordinal}`;
    const known = this.pages.get(key);
    if (known) {
      this.hotPages[slot] = { identity, ordinal, buffer: known };
      return known;
    }

    const start = ordinal * pageBytes;
    const buffer = Buffer.allocUnsafe(Math.min(pageBytes, size - start));
    const fd = this.descriptor(file);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, start + used);
      if (!count) throw new Error("Incomplete immutable tool source storage.");
      used += count;
    }
    this.pages.set(key, buffer, buffer.length);
    this.hotPages[slot] = { identity, ordinal, buffer };
    return buffer;
  }

  private offset(snapshot: Snapshot, line: number): number {
    const position = line * 8;
    const page = this.page(snapshot.offsets, `${snapshot.id}i`, position, (snapshot.lines + 1) * 8);
    return Number(page.readBigUInt64LE(position % pageBytes));
  }

  line(snapshot: Snapshot, line: number, splitCR = false): string {
    if (this.closed) throw new Error("Tool source storage is closed.");
    const prior = this.lastLine;
    if (prior?.snapshot === snapshot.id && prior.line === line)
      return splitCR && line + 1 < snapshot.lines && prior.text.endsWith("\r") ? prior.text.slice(0, -1) : prior.text;
    const key = `${snapshot.id}:${line}`;
    let text = this.decoded.get(key);
    if (text === undefined) {
      const start = this.offset(snapshot, line);
      let end = this.offset(snapshot, line + 1);
      if (line + 1 < snapshot.lines) {
        end--;
        if (end > start) {
          const page = this.page(snapshot.source, `${snapshot.id}d`, end - 1, snapshot.bytes);
          if (page[(end - 1) % pageBytes] === 13) end--;
        }
      }
      if (end === start) text = "";
      else {
        const first = this.page(snapshot.source, `${snapshot.id}d`, start, snapshot.bytes);
        const offset = start % pageBytes;
        if (end - start <= first.length - offset) text = first.toString("utf8", offset, offset + end - start);
        else {
          const bytes = Buffer.allocUnsafe(end - start);
          for (let at = start; at < end; ) {
            const page = this.page(snapshot.source, `${snapshot.id}d`, at, snapshot.bytes);
            const within = at % pageBytes,
              length = Math.min(page.length - within, end - at);
            page.copy(bytes, at - start, within, within + length);
            at += length;
          }
          text = bytes.toString("utf8");
        }
      }
      if (line === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.decoded.set(key, text, text.length * 2 + 96);
    }
    // A single giant physical line must not bypass the decoded-cache budget.
    this.lastLine = text.length <= pageBytes / 2 ? { snapshot: snapshot.id, line, text } : undefined;
    // headless.slurpFile normalizes once; Scene.loadLines splits that normalized
    // text again. Repeated CRs before LF must preserve this upstream distinction.
    return splitCR && line + 1 < snapshot.lines && text.endsWith("\r") ? text.slice(0, -1) : text;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of this.descriptors.values()) closeSync(fd);
    this.descriptors.clear();
    this.hotPages = [];
    this.lastLine = undefined;
    this.pages.clear();
    this.decoded.clear();
    this.latest.clear();
    rmSync(this.ownedDirectory, { recursive: true, force: true });
  }
}

/** Source identity is used only by upstream's optional parsed-lines cache. */
export class SceneText {
  constructor(
    private readonly store: SceneSources,
    private readonly snapshot: Snapshot,
    private readonly filename: string,
  ) {}

  get length(): number {
    return this.snapshot.characters;
  }
  [Symbol.toPrimitive](): string {
    return `bifoil-source:${this.snapshot.digest}`;
  }
  toString(): string {
    return this[Symbol.toPrimitive]();
  }

  lines(throwOnError = false): string[] {
    const lines = sourceLines(this.store, this.snapshot, this.snapshot.lines, false);
    if (throwOnError)
      for (let line = 0; line < lines.length; line++) {
        const invalid = /^(.*)\ufffd/.exec(lines[line]);
        if (invalid)
          throw new Error(
            `${this.filename} line ${line + 1}: invalid character. (ChoiceScript text should be saved in the UTF-8 encoding.)\n${invalid[0]}`,
          );
      }
    return lines;
  }

  split(separator: string | RegExp, limit?: number): string[] {
    const pattern = separator instanceof RegExp ? separator.source : undefined;
    if (separator !== "\n" && pattern !== "\\n" && pattern !== "\\r?\\n")
      throw new Error("Unsupported source split in the pinned tool adapter.");
    const count = Math.min(this.snapshot.lines, limit === undefined ? this.snapshot.lines : limit >>> 0);
    return sourceLines(this.store, this.snapshot, count, pattern === "\\r?\\n");
  }

  /** The two whole-source metadata regexes used by pinned autotest.js. */
  metadataMatch(pattern: RegExp, execute: typeof RegExp.prototype.exec): RegExpExecArray | null {
    if (pattern.flags !== "m" || !["^\\*title (.*)", "^\\*author "].includes(pattern.source))
      throw new Error("Unsupported direct source regular expression in the pinned tool adapter.");
    let offset = 0;
    for (let line = 0; line < this.snapshot.lines; line++) {
      const text = this.store.line(this.snapshot, line);
      const match = execute.call(pattern, text);
      if (match) {
        match.index += offset;
        // Pinned autotest reads the capture/index only. Preserve full input on
        // demand too, without allocating it for metadata checks on giant scenes.
        let input: string | undefined;
        Object.defineProperty(match, "input", {
          configurable: true,
          enumerable: true,
          get: () => (input ??= this.lines().join("\n")),
          set: (value: string) => {
            input = value;
          },
        });
        return match;
      }
      offset += text.length + (line + 1 < this.snapshot.lines ? 1 : 0);
    }
    return null;
  }

  crc32(calculate: (text: string, crc?: number) => number, initial?: number): number {
    let crc = initial ?? 0;
    for (let line = 0; line < this.snapshot.lines; line++) {
      crc = calculate(this.store.line(this.snapshot, line), crc);
      if (line + 1 < this.snapshot.lines) crc = calculate("\n", crc);
    }
    return crc;
  }
}

function sourceLines(store: SceneSources, snapshot: Snapshot, count: number, splitCR: boolean): string[] {
  const target: string[] = [];
  // An accessor moves V8's target to sparse dictionary elements before length is
  // assigned. A hole-filled array would itself cost O(physical lines) in memory.
  Object.defineProperty(target, "0", { get: () => "", configurable: true });
  delete target[0];
  target.length = count;
  let visible = count;
  const deleted = new Set<number>();
  const indexOf = (key: string | symbol) =>
    typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff ? Number(key) : undefined;
  const virtual = (index: number) => index < visible && !deleted.has(index) && !Object.hasOwn(target, index);

  const view = new Proxy(target, {
    get(target, key, receiver) {
      if (key === "length") return target.length;
      const index = indexOf(key);
      if (index !== undefined && virtual(index)) return store.line(snapshot, index, splitCR);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      const index = indexOf(key);
      return (index !== undefined && virtual(index)) || Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      const index = indexOf(key);
      if (index !== undefined && virtual(index))
        return { configurable: true, enumerable: true, writable: true, value: store.line(snapshot, index, splitCR) };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      const numeric = keys.filter((key) => indexOf(key) !== undefined) as string[];
      for (let index = 0; index < visible; index++) if (virtual(index)) numeric.push(String(index));
      numeric.sort((a, b) => Number(a) - Number(b));
      return [...numeric, ...keys.filter((key) => indexOf(key) === undefined)];
    },
    set(target, key, value) {
      const accepted = Reflect.set(target, key, value, target);
      if (key === "length") {
        visible = Math.min(visible, target.length);
        for (const index of deleted) if (index >= visible) deleted.delete(index);
      }
      return accepted;
    },
    defineProperty(target, key, descriptor) {
      const index = indexOf(key);
      if (index !== undefined && virtual(index))
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: store.line(snapshot, index, splitCR),
        });
      const accepted = Reflect.defineProperty(target, key, descriptor);
      if (key === "length") visible = Math.min(visible, target.length);
      return accepted;
    },
    deleteProperty(target, key) {
      const index = indexOf(key);
      const accepted = Reflect.deleteProperty(target, key);
      if (accepted && index !== undefined && index < visible) deleted.add(index);
      return accepted;
    },
    preventExtensions(target) {
      for (let index = 0; index < visible; index++)
        if (virtual(index)) target[index] = store.line(snapshot, index, splitCR);
      visible = 0;
      deleted.clear();
      return Reflect.preventExtensions(target);
    },
  });
  lineViews.add(view);
  return view;
}
