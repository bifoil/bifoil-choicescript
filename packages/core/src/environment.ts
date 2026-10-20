import { joinValue, unknown, type Value } from "./types.js";

/** Compare abstract values, including their canonical ordered type sets. */
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

type Binding = {
  key: string;
  value: Value;
  left?: Binding;
  right?: Binding;
  height: number;
  size: number;
};

type Difference = [key: string, left: Value | undefined, right: Value | undefined];

const height = (node?: Binding): number => node?.height ?? 0;

function binding(key: string, value: Value, left?: Binding, right?: Binding): Binding {
  return {
    key,
    value,
    left,
    right,
    height: 1 + Math.max(height(left), height(right)),
    size: 1 + (left?.size ?? 0) + (right?.size ?? 0),
  };
}

function rotateLeft(node: Binding): Binding {
  const right = node.right!;
  return binding(right.key, right.value, binding(node.key, node.value, node.left, right.left), right.right);
}

function rotateRight(node: Binding): Binding {
  const left = node.left!;
  return binding(left.key, left.value, left.left, binding(node.key, node.value, left.right, node.right));
}

/** AVL balancing bounds lookup/update depth even for adversarial source identifiers. */
function balance(node: Binding): Binding {
  const delta = height(node.left) - height(node.right);

  if (delta > 1) {
    const left = node.left!;
    if (height(left.left) < height(left.right)) node = binding(node.key, node.value, rotateLeft(left), node.right);
    return rotateRight(node);
  }

  if (delta < -1) {
    const right = node.right!;
    if (height(right.right) < height(right.left)) node = binding(node.key, node.value, node.left, rotateRight(right));
    return rotateLeft(node);
  }

  return node;
}

function set(node: Binding | undefined, key: string, value: Value): Binding {
  if (!node) return binding(key, value);
  if (key === node.key) return sameValue(value, node.value) ? node : binding(key, value, node.left, node.right);

  if (key < node.key) {
    const left = set(node.left, key, value);
    return left === node.left ? node : balance(binding(node.key, node.value, left, node.right));
  }

  const right = set(node.right, key, value);
  return right === node.right ? node : balance(binding(node.key, node.value, node.left, right));
}

function remove(node: Binding | undefined, key: string): Binding | undefined {
  if (!node) return undefined;

  if (key < node.key) {
    const left = remove(node.left, key);
    return left === node.left ? node : balance(binding(node.key, node.value, left, node.right));
  }

  if (key > node.key) {
    const right = remove(node.right, key);
    return right === node.right ? node : balance(binding(node.key, node.value, node.left, right));
  }

  if (!node.left) return node.right;
  if (!node.right) return node.left;

  let next = node.right;
  while (next.left) next = next.left;
  return balance(binding(next.key, next.value, node.left, remove(node.right, next.key)));
}

function* entries(node?: Binding): IterableIterator<[string, Value]> {
  const stack: Binding[] = [];
  while (node || stack.length) {
    while (node) {
      stack.push(node);
      node = node.left;
    }
    const current = stack.pop()!;
    yield [current.key, current.value];
    node = current.right;
  }
}

/** Skip shared subtrees; merge sorted entries when insertions changed tree shape. */
function* differences(a?: Binding, b?: Binding): IterableIterator<Difference> {
  const pending: [Binding | undefined, Binding | undefined][] = [[a, b]];
  while (pending.length) {
    const [leftRoot, rightRoot] = pending.pop()!;
    if (leftRoot === rightRoot) continue;
    if (leftRoot && rightRoot && leftRoot.key === rightRoot.key) {
      if (!sameValue(leftRoot.value, rightRoot.value)) yield [leftRoot.key, leftRoot.value, rightRoot.value];
      if (leftRoot.right !== rightRoot.right) pending.push([leftRoot.right, rightRoot.right]);
      if (leftRoot.left !== rightRoot.left) pending.push([leftRoot.left, rightRoot.left]);
      continue;
    }
    const left = entries(leftRoot),
      right = entries(rightRoot);
    let x = left.next(),
      y = right.next();
    while (!x.done || !y.done) {
      if (y.done || (!x.done && x.value[0] < y.value[0])) {
        yield [x.value![0], x.value![1], undefined];
        x = left.next();
      } else if (x.done || y.value[0] < x.value[0]) {
        yield [y.value[0], undefined, y.value[1]];
        y = right.next();
      } else {
        if (!sameValue(x.value[1], y.value[1])) yield [x.value[0], x.value[1], y.value[1]];
        x = left.next();
        y = right.next();
      }
    }
  }
}

/**
 * Persistent abstract environment. A fork shares an immutable AVL tree; an update
 * copies only its search path, rather than the entire variable table at every flow
 * point. Values remain shared and must be replaced instead of mutated. Iteration
 * observes the root at its start, so scope deletion during iteration is safe.
 */
export class Environment {
  private root?: Binding;

  protected get nativeStorage(): boolean {
    return false;
  }

  constructor(values?: Iterable<[string, Value]>) {
    if (values) for (const [key, value] of values) this.set(key, value);
  }

  get size(): number {
    return this.root?.size ?? 0;
  }

  /** Create an empty environment in the same storage domain. */
  empty(): Environment {
    return new Environment();
  }

  clone(): Environment {
    const copy = new Environment();
    copy.root = this.root;
    return copy;
  }

  shares(other: Environment): boolean {
    return !other.nativeStorage && this.root === other.root;
  }

  equals(other: Environment): boolean {
    if (other.nativeStorage) {
      if (this.size !== other.size) return false;
      for (const [key, value] of this) if (!sameValue(value, other.get(key))) return false;
      return true;
    }
    return this.size === other.size && differences(this.root, other.root).next().done === true;
  }

  /** Join only differing bindings; an absent binding contributes unknown. */
  join(other: Environment): Environment {
    const result = this.clone();
    if (other.nativeStorage) {
      for (const key of new Set([...this.keys(), ...other.keys()]))
        result.set(key, joinValue(this.get(key) ?? unknown(), other.get(key) ?? unknown()));
      return result;
    }
    for (const [key, left, right] of differences(this.root, other.root))
      result.set(key, joinValue(left ?? unknown(), right ?? unknown()));
    return result;
  }

  *entriesWithPrefix(prefix: string): IterableIterator<[string, Value]> {
    for (const entry of this) if (entry[0].startsWith(prefix)) yield entry;
  }

  deletePrefix(prefix: string): void {
    for (const [key] of this.entriesWithPrefix(prefix)) this.delete(key);
  }

  get(key: string): Value | undefined {
    let node = this.root;
    while (node) {
      if (key === node.key) return node.value;
      node = key < node.key ? node.left : node.right;
    }
    return undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  *keys(): IterableIterator<string> {
    for (const [key] of entries(this.root)) yield key;
  }

  [Symbol.iterator](): IterableIterator<[string, Value]> {
    return entries(this.root);
  }

  set(key: string, value: Value): void {
    this.root = set(this.root, key, value);
  }

  delete(key: string): void {
    this.root = remove(this.root, key);
  }
}
