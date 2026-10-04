export type ConcurrencyLimits = {
  /** Calls allowed to run at once. */
  maxConcurrent: number;
  /** Calls allowed to wait for a slot; one more is rejected immediately. */
  maxWaiting: number;
  /** Longest a call waits for a slot before it is rejected. */
  maxWaitMs: number;
};

export type ConcurrencyLimitReason = "queue_full" | "wait_timeout";

/**
 * Thrown when a call could not get a slot: the waiting line was full on arrival, or the call
 * waited longer than `maxWaitMs`. The call never started, so it is always safe to retry.
 */
export class ConcurrencyLimitError extends Error {
  readonly reason: ConcurrencyLimitReason;

  constructor(reason: ConcurrencyLimitReason) {
    super(
      reason === "queue_full"
        ? "Too many calls are waiting for a free slot"
        : "Timed out waiting for a free slot"
    );
    this.name = "ConcurrencyLimitError";
    this.reason = reason;
  }
}

type Waiter = {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * In-process concurrency limit with a bounded FIFO waiting line. Up to `maxConcurrent` calls
 * run at once; the rest wait in arrival order for a slot, so a burst queues instead of failing.
 * A slot is handed straight to the longest waiter when one frees up, so nobody can jump the line.
 * Per process: it limits this instance, not a fleet.
 */
export class ConcurrencyLimiter {
  private limits: ConcurrencyLimits;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(limits: ConcurrencyLimits) {
    this.limits = { ...limits };
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Replace the limits. Calls already running or waiting keep the slot or place they have. */
  configure(limits: Partial<ConcurrencyLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  /**
   * Run `action` once a slot is free and release the slot when it settles, success or failure.
   * Rejects with ConcurrencyLimitError, without running `action`, if no slot becomes available
   * in time. Errors from `action` itself pass through untouched.
   */
  async run<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await action();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limits.maxConcurrent && this.queue.length === 0) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.limits.maxWaiting) {
      return Promise.reject(new ConcurrencyLimitError("queue_full"));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new ConcurrencyLimitError("wait_timeout"));
        }, this.limits.maxWaitMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    if (this.active >= this.limits.maxConcurrent) return;
    const next = this.queue.shift();
    if (next) {
      // Grant the slot synchronously, before any new arrival can see it free.
      clearTimeout(next.timer);
      this.active += 1;
      next.grant();
    }
  }
}
