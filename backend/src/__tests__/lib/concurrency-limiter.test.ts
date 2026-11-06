import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimitError, ConcurrencyLimiter } from "../../lib/concurrency-limiter";

// A call whose completion the test controls.
function deferred<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  // Let queued microtasks (slot hand-offs, continuations) run.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("ConcurrencyLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const limits = { maxConcurrent: 2, maxWaiting: 3, maxWaitMs: 1000 };

  it("runs up to maxConcurrent calls at once and counts slots", async () => {
    const limiter = new ConcurrencyLimiter(limits);
    const a = deferred();
    const b = deferred();
    const started: string[] = [];

    const ra = limiter.run(() => {
      started.push("a");
      return a.promise;
    });
    const rb = limiter.run(() => {
      started.push("b");
      return b.promise;
    });
    await flush();

    expect(started).toEqual(["a", "b"]);
    expect(limiter.inFlight).toBe(2);
    expect(limiter.waiting).toBe(0);

    a.resolve("a");
    b.resolve("b");
    await expect(ra).resolves.toBe("a");
    await expect(rb).resolves.toBe("b");
    expect(limiter.inFlight).toBe(0);
  });

  it("makes calls beyond the limit wait, and starts them first-in first-out", async () => {
    const limiter = new ConcurrencyLimiter({ ...limits, maxConcurrent: 1 });
    const gate = deferred();
    const order: string[] = [];

    const first = limiter.run(async () => {
      order.push("first");
      await gate.promise;
    });
    const waiters = ["w1", "w2", "w3"].map((name) =>
      limiter.run(async () => {
        order.push(name);
      })
    );
    await flush();

    expect(order).toEqual(["first"]);
    expect(limiter.inFlight).toBe(1);
    expect(limiter.waiting).toBe(3);

    gate.resolve("go");
    await Promise.all([first, ...waiters]);
    expect(order).toEqual(["first", "w1", "w2", "w3"]);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it("does not let a new arrival jump ahead of calls already waiting", async () => {
    const limiter = new ConcurrencyLimiter({ ...limits, maxConcurrent: 1 });
    const gate = deferred();
    const order: string[] = [];

    const first = limiter.run(() => gate.promise);
    const early = limiter.run(async () => {
      order.push("early");
    });
    await flush();

    gate.resolve("go");
    // Arrives in the same tick the slot frees up.
    const late = limiter.run(async () => {
      order.push("late");
    });
    await Promise.all([first, early, late]);
    expect(order).toEqual(["early", "late"]);
  });

  it("releases the slot when the call succeeds", async () => {
    const limiter = new ConcurrencyLimiter({ ...limits, maxConcurrent: 1 });
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.run(async () => "again")).resolves.toBe("again");
  });

  it("releases the slot when the call fails, and passes the error through untouched", async () => {
    const limiter = new ConcurrencyLimiter({ ...limits, maxConcurrent: 1 });
    const boom = new Error("stripe exploded");

    await expect(limiter.run(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.run(async () => "after")).resolves.toBe("after");
  });

  it("hands a failed call's slot to the next waiter", async () => {
    const limiter = new ConcurrencyLimiter({ ...limits, maxConcurrent: 1 });
    const gate = deferred();

    const failing = limiter.run(async () => {
      await gate.promise;
      throw new Error("nope");
    });
    const next = limiter.run(async () => "ran");
    await flush();
    expect(limiter.waiting).toBe(1);

    gate.resolve("go");
    await expect(failing).rejects.toThrow("nope");
    await expect(next).resolves.toBe("ran");
    expect(limiter.inFlight).toBe(0);
  });

  it("rejects a call that waits longer than maxWaitMs, without running it", async () => {
    const limiter = new ConcurrencyLimiter({ ...limits, maxConcurrent: 1, maxWaitMs: 1000 });
    const gate = deferred();
    const action = vi.fn(async () => "never");

    const holder = limiter.run(() => gate.promise);
    const waiter = limiter.run(action);
    const outcome = waiter.then(
      () => null,
      (error: unknown) => error
    );
    await flush();
    expect(limiter.waiting).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(limiter.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(ConcurrencyLimitError);
    expect((error as ConcurrencyLimitError).reason).toBe("wait_timeout");
    expect(action).not.toHaveBeenCalled();
    // The timed-out call left the line and holds no slot.
    expect(limiter.waiting).toBe(0);
    expect(limiter.inFlight).toBe(1);

    gate.resolve("go");
    await holder;
    expect(limiter.inFlight).toBe(0);
  });

  it("serves the waiters behind a timed-out call normally", async () => {
    const limiter = new ConcurrencyLimiter({ ...limits, maxConcurrent: 1, maxWaitMs: 1000 });
    const gate = deferred();

    const holder = limiter.run(() => gate.promise);
    const timedOut = limiter.run(async () => "x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600);
    const later = limiter.run(async () => "later");
    await vi.advanceTimersByTimeAsync(400); // the first waiter times out, the later one has 600 ms left

    expect(await timedOut).toBeInstanceOf(ConcurrencyLimitError);
    expect(limiter.waiting).toBe(1);

    gate.resolve("go");
    await holder;
    await expect(later).resolves.toBe("later");
  });

  it("does not time out a call that got its slot in time", async () => {
    const limiter = new ConcurrencyLimiter({ ...limits, maxConcurrent: 1, maxWaitMs: 1000 });
    const gate = deferred();

    const holder = limiter.run(() => gate.promise);
    const waiter = limiter.run(async () => "served");
    await vi.advanceTimersByTimeAsync(500);
    gate.resolve("go");
    await holder;
    await expect(waiter).resolves.toBe("served");

    // The wait timer was cancelled: nothing fires later.
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately when maxWaiting calls are already waiting", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxWaiting: 2, maxWaitMs: 1000 });
    const gate = deferred();
    const action = vi.fn(async () => "never");

    const holder = limiter.run(() => gate.promise);
    const w1 = limiter.run(async () => "w1");
    const w2 = limiter.run(async () => "w2");
    await flush();
    expect(limiter.waiting).toBe(2);

    const error = await limiter.run(action).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConcurrencyLimitError);
    expect((error as ConcurrencyLimitError).reason).toBe("queue_full");
    expect(action).not.toHaveBeenCalled();
    // No timer, no place in line, and the waiters already queued are unaffected.
    expect(limiter.waiting).toBe(2);

    gate.resolve("go");
    await holder;
    await expect(w1).resolves.toBe("w1");
    await expect(w2).resolves.toBe("w2");
  });

  it("accepts waiters again once the line shortens", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxWaiting: 1, maxWaitMs: 1000 });
    const gate = deferred();

    const holder = limiter.run(() => gate.promise);
    const w1 = limiter.run(async () => "w1");
    await flush();
    await expect(limiter.run(async () => "x")).rejects.toBeInstanceOf(ConcurrencyLimitError);

    gate.resolve("go");
    await holder;
    await w1;
    await expect(limiter.run(async () => "fresh")).resolves.toBe("fresh");
  });

  it("applies new limits to later calls via configure", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 1000 });
    const gate = deferred();
    const holder = limiter.run(() => gate.promise);
    await expect(limiter.run(async () => "x")).rejects.toBeInstanceOf(ConcurrencyLimitError);

    limiter.configure({ maxConcurrent: 2 });
    await expect(limiter.run(async () => "second slot")).resolves.toBe("second slot");

    gate.resolve("go");
    await holder;
  });

  it("describes the reason on the error", () => {
    expect(new ConcurrencyLimitError("queue_full").message).toMatch(/waiting/i);
    expect(new ConcurrencyLimitError("wait_timeout").message).toMatch(/timed out/i);
    expect(new ConcurrencyLimitError("queue_full").name).toBe("ConcurrencyLimitError");
  });
});
