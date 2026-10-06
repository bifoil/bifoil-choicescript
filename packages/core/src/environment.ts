import type { Value } from "./types.js";

/**
 * Compare canonical abstract values, including ordered type sets; undefined equals only undefined.
 */
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

/**
 * Copy-on-write abstract environment for branch and call states.
 * clone() shares the backing map until set/delete changes one fork. Value objects are
 * still shared: callers must replace values rather than mutate their fields or type arrays.
 * The input map becomes owned storage; do not mutate it through an external alias.
 */
export class Environment {
  private shared = false;

  constructor(private values = new Map<string, Value>()) {}

  get size(): number {
    return this.values.size;
  }

  /**
   * Fork without copying the map. Both the original and clone must detach before their next effective write.
   */
  clone(): Environment {
    this.shared = true;
    const copy = new Environment(this.values);
    copy.shared = true;

    return copy;
  }

  /**
   * Identity fast path for unchanged states; false does not imply different abstract contents.
   */
  shares(other: Environment): boolean {
    return this.values === other.values;
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

  private writable(): void {
    if (this.shared) {
      this.values = new Map(this.values);
      this.shared = false;
    }
  }
}
