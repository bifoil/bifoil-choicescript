import { Environment } from "./environment.js";
import { environmentBinary } from "./environment-binary.js";
import { joinValue, unknown, type Value, type ValueType } from "./types.js";

interface ArenaExports {
  memory: { buffer: ArrayBuffer };
  env_reset(): void;
  env_size(root: number): number;
  env_get(root: number, key: number): number;
  env_set(root: number, key: number, value: number): number;
  env_join(left: number, right: number): number;
  env_equal(left: number, right: number): number;
  env_entries(root: number): number;
  env_collect_needed(): number;
  env_collect_begin(): void;
  env_mark(root: number): void;
  env_collect_end(): void;
  env_committed_nodes(): number;
}

// Structural declarations keep the language core independent of DOM/Node APIs.
const wasm = (
  globalThis as unknown as {
    WebAssembly: {
      Module: new (bytes: Uint8Array) => unknown;
      Instance: new (module: unknown) => { exports: ArenaExports };
    };
  }
).WebAssembly;
let compiled: unknown;
const typeNames: ValueType[] = ["boolean", "number", "string", "unknown"];
const typeBits: Record<ValueType, number> = { boolean: 1, number: 2, string: 4, unknown: 8 };
const typeSets = Array.from({ length: 16 }, (_, mask) => typeNames.filter((type) => mask & typeBits[type]));

/**
 * One analysis-owned arena. Handles are valid until reset; collection is allowed
 * only at a flow safe point supplying every live environment, never during a
 * transfer. The original C source bounds nodes to approximately 32 MiB and the
 * module's linear memory to 48 MiB including export scratch/stack.
 */
export class NativeEnvironmentArena {
  private readonly api: ArenaExports;
  private readonly identifiers = new Map<string, number>();
  private readonly names: string[] = [];
  private readonly prefixes = new Map<string, number[]>();
  private readonly constantIds = new Map<string | number | boolean, number>();
  private readonly constants: (string | number | boolean)[] = [];
  private readonly decoded = new Map<number, Value>();

  constructor() {
    compiled ??= new wasm.Module(Uint8Array.from(atob(environmentBinary), (char) => char.charCodeAt(0)));
    this.api = new wasm.Instance(compiled).exports;
  }

  reset(): void {
    this.api.env_reset();
    this.identifiers.clear();
    this.names.length = 0;
    this.prefixes.clear();
    this.constantIds.clear();
    this.constants.length = 0;
    this.decoded.clear();
  }

  environment(values?: Iterable<[string, Value]>): Environment {
    const result = new NativeEnvironment(this, 0);
    if (values) for (const [key, value] of values) result.set(key, value);
    return result;
  }

  get needsCollection(): boolean {
    return this.api.env_collect_needed() !== 0;
  }
  get committedBytes(): number {
    return this.api.memory.buffer.byteLength;
  }

  collect(roots: Iterable<Environment>): void {
    this.api.env_collect_begin();
    for (const root of roots)
      if (root instanceof NativeEnvironment && root.arena === this) this.api.env_mark(root.handle);
    this.api.env_collect_end();
  }

  private checked(root: number): number {
    const value = root >>> 0;
    if (value === 0xffffffff) throw new Error("The compiled environment arena exhausted its bounded storage.");
    return value;
  }

  private encode(value: Value): number {
    let mask = 0;
    for (const type of value.types) mask |= typeBits[type];
    if (!mask) throw new Error("An abstract value must contain at least one type.");
    if (value.constant === undefined) return mask;
    let id = this.constantIds.get(value.constant);
    if (id === undefined) {
      id = this.constants.length + 1;
      if (id >= 0x0fffffff) throw new Error("Too many abstract constants.");
      this.constants.push(value.constant);
      this.constantIds.set(value.constant, id);
    }
    return id * 16 + mask;
  }

  private decode(value: number): Value | undefined {
    if (!value) return undefined;
    let result = this.decoded.get(value);
    if (!result) {
      const constant = value >>> 4;
      result = constant
        ? { types: typeSets[value & 15], constant: this.constants[constant - 1] }
        : { types: typeSets[value & 15] };
      this.decoded.set(value, result);
    }
    return result;
  }

  *entriesWithPrefix(root: number, prefix: string): IterableIterator<[string, Value]> {
    let ids = this.prefixes.get(prefix);
    if (!ids) {
      ids = [];
      for (let i = 0; i < this.names.length; i++) if (this.names[i].startsWith(prefix)) ids.push(i);
      this.prefixes.set(prefix, ids);
    }
    const values: [string, Value][] = [];
    for (const id of ids) {
      const value = this.decode(this.api.env_get(root, id) >>> 0);
      if (value) values.push([this.names[id], value]);
    }
    yield* values;
  }

  size(root: number): number {
    return this.api.env_size(root);
  }
  get(root: number, key: string): Value | undefined {
    const id = this.identifiers.get(key);
    return id === undefined ? undefined : this.decode(this.api.env_get(root, id) >>> 0);
  }
  set(root: number, key: string, value: Value | undefined): number {
    let id = this.identifiers.get(key);
    if (id === undefined) {
      if (value === undefined) return root;
      id = this.names.length;
      this.names.push(key);
      this.identifiers.set(key, id);
      for (const [prefix, ids] of this.prefixes) if (key.startsWith(prefix)) ids.push(id);
    }
    return this.checked(this.api.env_set(root, id, value === undefined ? 0 : this.encode(value)));
  }
  join(left: number, right: number): number {
    return this.checked(this.api.env_join(left, right));
  }
  equal(left: number, right: number): boolean {
    return this.api.env_equal(left, right) !== 0;
  }
  *entries(root: number): IterableIterator<[string, Value]> {
    const count = this.api.env_size(root);
    if (!count) return;
    const pointer = this.checked(this.api.env_entries(root));
    // Own the iteration snapshot: transfers may replace pages, and a nested
    // iterator may reuse native scratch. Values remain immutable JS primitives.
    const pairs = new Uint32Array(this.api.memory.buffer, pointer, count * 2).slice();
    for (let i = 0; i < pairs.length; i += 2) yield [this.names[pairs[i]], this.decode(pairs[i + 1])!];
  }
}

class NativeEnvironment extends Environment {
  protected override get nativeStorage(): boolean {
    return true;
  }
  constructor(
    readonly arena: NativeEnvironmentArena,
    public handle: number,
  ) {
    super();
  }
  override get size(): number {
    return this.arena.size(this.handle);
  }
  override empty(): Environment {
    return new NativeEnvironment(this.arena, 0);
  }
  override clone(): Environment {
    return new NativeEnvironment(this.arena, this.handle);
  }
  override shares(other: Environment): boolean {
    return other instanceof NativeEnvironment && other.arena === this.arena && other.handle === this.handle;
  }
  override equals(other: Environment): boolean {
    if (other instanceof NativeEnvironment && other.arena === this.arena)
      return this.arena.equal(this.handle, other.handle);
    if (this.size !== other.size) return false;
    for (const [key, value] of this) {
      const right = other.get(key);
      if (
        !right ||
        value.constant !== right.constant ||
        value.types.length !== right.types.length ||
        value.types.some((type, i) => type !== right.types[i])
      )
        return false;
    }
    return true;
  }
  override join(other: Environment): Environment {
    if (other instanceof NativeEnvironment && other.arena === this.arena)
      return new NativeEnvironment(this.arena, this.arena.join(this.handle, other.handle));
    const result = this.clone();
    for (const key of new Set([...this.keys(), ...other.keys()]))
      result.set(key, joinValue(this.get(key) ?? unknown(), other.get(key) ?? unknown()));
    return result;
  }
  override entriesWithPrefix(prefix: string): IterableIterator<[string, Value]> {
    return this.arena.entriesWithPrefix(this.handle, prefix);
  }
  override get(key: string): Value | undefined {
    return this.arena.get(this.handle, key);
  }
  override has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  override set(key: string, value: Value): void {
    this.handle = this.arena.set(this.handle, key, value);
  }
  override delete(key: string): void {
    this.handle = this.arena.set(this.handle, key, undefined);
  }
  override *keys(): IterableIterator<string> {
    for (const [key] of this.arena.entries(this.handle)) yield key;
  }
  override [Symbol.iterator](): IterableIterator<[string, Value]> {
    return this.arena.entries(this.handle);
  }
}

let idle: NativeEnvironmentArena | undefined;
export function acquireEnvironmentArena(): NativeEnvironmentArena {
  const arena = idle ?? new NativeEnvironmentArena();
  idle = undefined;
  arena.reset();
  return arena;
}
export function releaseEnvironmentArena(arena: NativeEnvironmentArena): void {
  arena.reset();
  idle ??= arena;
}
