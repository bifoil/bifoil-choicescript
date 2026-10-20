/**
 * Complete per-line coverage with bounded growth overhead. Normal counts use
 * four bytes; a chunk promotes losslessly to doubles if an official count needs
 * them. The borrowed read-only Array view keeps the existing event protocol and
 * streams through the private transport without another game-sized number array.
 */
const chunkSize = 4096;
const views = new WeakMap<number[], CoverageSeries>();

export class CoverageSeries {
  private readonly chunks: (Uint32Array | Float64Array)[] = [];
  private count = 0;

  push(value: number): void {
    const index = Math.floor(this.count / chunkSize);
    let chunk = this.chunks[index];
    if (!chunk) this.chunks[index] = chunk = new Uint32Array(chunkSize);
    if (chunk instanceof Uint32Array && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
      this.chunks[index] = chunk = Float64Array.from(chunk);
    chunk[this.count % chunkSize] = value;
    this.count++;
  }

  /** The series must not be appended after its view is handed to consumers. */
  view(): number[] {
    const length = this.count;
    const target: number[] = [];
    // Force sparse elements before assigning length, avoiding a dense hole array.
    Object.defineProperty(target, "0", { get: () => 0, configurable: true });
    delete target[0];
    target.length = length;
    const indexOf = (key: string | symbol) =>
      typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length ? Number(key) : undefined;
    const at = (index: number) => this.chunks[Math.floor(index / chunkSize)][index % chunkSize];
    const readonly = () => {
      throw new TypeError("Coverage counts are read-only.");
    };
    const view = new Proxy(target, {
      get(target, key, receiver) {
        const index = indexOf(key);
        return index === undefined ? Reflect.get(target, key, receiver) : at(index);
      },
      has(target, key) {
        return indexOf(key) !== undefined || Reflect.has(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        const index = indexOf(key);
        return index === undefined
          ? Reflect.getOwnPropertyDescriptor(target, key)
          : { configurable: true, enumerable: true, writable: false, value: at(index) };
      },
      ownKeys() {
        return [...Array.from({ length }, (_, index) => String(index)), "length"];
      },
      set: readonly,
      defineProperty: readonly,
      deleteProperty: readonly,
      preventExtensions: readonly,
    });
    views.set(view, this);
    return view;
  }

  *jsonChunks(): Generator<string> {
    yield "[";
    // Reuse one plain numeric array: allocating a new boxed array per chunk
    // creates avoidable transient heap even though transport writes are bounded.
    const values: number[] = [];
    for (let offset = 0; offset < this.count; offset += 1024) {
      const chunk = this.chunks[Math.floor(offset / chunkSize)];
      const begin = offset % chunkSize;
      values.length = Math.min(1024, this.count - offset);
      for (let index = 0; index < values.length; index++) values[index] = chunk[begin + index];
      yield (offset ? "," : "") + JSON.stringify(values).slice(1, -1);
    }
    yield "]";
  }
}

/** JSON.stringify's generic Proxy path retains millions of property keys in V8.
 * Serialize numeric chunks explicitly in the bounded native broker instead.
 */
export function* coverageJSONChunks(counts: number[]): Generator<string> {
  const series = views.get(counts);
  if (series) yield* series.jsonChunks();
  else {
    yield "[";
    const values: number[] = [];
    for (let offset = 0; offset < counts.length; offset += 1024) {
      values.length = Math.min(1024, counts.length - offset);
      for (let index = 0; index < values.length; index++) values[index] = counts[offset + index];
      yield (offset ? "," : "") + JSON.stringify(values).slice(1, -1);
    }
    yield "]";
  }
}
