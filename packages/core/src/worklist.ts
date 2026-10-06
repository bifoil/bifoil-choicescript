/**
 * Stable min-priority queue: lower numbers run first, ties preserve insertion order.
 * Earlier control-flow branches can converge before a long continuation is revisited.
 * This queue does not deduplicate; analysis maintains its own pending-key set.
 */
export class Worklist<T> {
  private heap: { priority: number; order: number; value: T }[] = [];
  private sequence = 0;

  get size(): number {
    return this.heap.length;
  }

  peek(): T | undefined {
    return this.heap[0]?.value;
  }

  push(value: T, priority: number): void {
    const entry = { value, priority, order: this.sequence++ };
    let i = this.heap.length;
    this.heap.push(entry);

    while (i > 0) {
      const parent = (i - 1) >>> 1;

      if (!this.before(entry, this.heap[parent])) break;

      this.heap[i] = this.heap[parent];
      i = parent;
    }

    this.heap[i] = entry;
  }

  pop(): T | undefined {
    const first = this.heap[0];
    const last = this.heap.pop();

    if (last && this.heap.length) {
      let i = 0;

      while (i * 2 + 1 < this.heap.length) {
        let child = i * 2 + 1;

        if (child + 1 < this.heap.length && this.before(this.heap[child + 1], this.heap[child])) child++;
        if (!this.before(this.heap[child], last)) break;

        this.heap[i] = this.heap[child];
        i = child;
      }

      this.heap[i] = last;
    }

    return first?.value;
  }

  private before(a: { priority: number; order: number }, b: { priority: number; order: number }): boolean {
    return a.priority < b.priority || (a.priority === b.priority && a.order < b.order);
  }
}
