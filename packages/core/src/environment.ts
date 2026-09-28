import type { Value } from "./types.js";

export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.constant === b.constant &&
      a.types.length === b.types.length &&
      a.types.every((type, i) => type === b.types[i]))
  );
}

/** Fork cheaply at each source line; copy the variable table only on a write. */
export class Environment {
  private shared = false;
  constructor(private values = new Map<string, Value>()) {}

  clone(): Environment {
    this.shared = true;
    const copy = new Environment(this.values);
    copy.shared = true;
    return copy;
  }

  shares(other: Environment): boolean {
    return this.values === other.values;
  }
  get size(): number {
    return this.values.size;
  }
  get(key: string): Value | undefined {
    return this.values.get(key);
  }
  has(key: string): boolean {
    return this.values.has(key);
  }
  keys(): MapIterator<string> {
    return this.values.keys();
  }
  [Symbol.iterator](): MapIterator<[string, Value]> {
    return this.values[Symbol.iterator]();
  }

  private writable(): void {
    if (this.shared) {
      this.values = new Map(this.values);
      this.shared = false;
    }
  }

  set(key: string, value: Value): void {
    if (sameValue(this.values.get(key), value)) return;
    this.writable();
    this.values.set(key, value);
  }

  delete(key: string): void {
    if (!this.values.has(key)) return;
    this.writable();
    this.values.delete(key);
  }
}
