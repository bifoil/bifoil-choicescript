type Waiter = {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};

/**
 * FIFO semaphore with one permit for generator/test/compiler children.
 * Cancellation removes a waiting acquisition; it does not terminate a process already
 * holding the permit. The owner must release after child settlement, including failures.
 */
export class ProcessSlot {
  private active = false;
  private readonly waiting: Waiter[] = [];

  /**
   * Acquire the permit or reject when the supplied signal aborts while waiting.
   * Returns an idempotent release function; call it in a `finally` block around the owned child.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();

    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.release());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiting.indexOf(waiter);

          if (index >= 0) this.waiting.splice(index, 1);

          signal?.removeEventListener("abort", waiter.abort);
          reject(signal?.reason ?? new Error("Operation cancelled."));
        },
      };
      this.waiting.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
    });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;

      released = true;

      const next = this.waiting.shift();

      if (next) {
        next.signal?.removeEventListener("abort", next.abort);
        next.resolve(this.release());
      } else this.active = false;
    };
  }
}
