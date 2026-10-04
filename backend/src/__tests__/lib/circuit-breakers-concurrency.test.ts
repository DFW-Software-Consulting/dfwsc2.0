import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// withStripeCircuit caps Stripe calls in flight and queues the rest. Time spent waiting for a
// slot, and a refusal to wait, are not Stripe failures and must never reach the breaker.

async function load() {
  vi.resetModules();
  return import("../../lib/circuit-breakers");
}

function deferred<T = string>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function stripeError(name: string, statusCode?: number) {
  const err = new Error(`${name} message`) as Error & { statusCode?: number };
  err.name = name;
  if (statusCode !== undefined) err.statusCode = statusCode;
  return err;
}

describe("withStripeCircuit concurrency limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("defaults to 25 in flight, 500 waiting and a 10 s wait", async () => {
    const mod = await load();
    const gates = Array.from({ length: 25 }, () => deferred());
    const running = gates.map((g) => mod.withStripeCircuit(() => g.promise));
    const waiting = Array.from({ length: 500 }, () =>
      mod.withStripeCircuit(async () => "queued").catch((e: unknown) => e)
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(mod.getStripeConcurrencyForTests()).toEqual({ inFlight: 25, waiting: 500 });

    // The 501st waiter is refused on arrival.
    await expect(mod.withStripeCircuit(async () => "extra")).rejects.toSatisfy(
      mod.isStripeBusyError
    );

    // A queued call that outwaits 10 s gives up.
    await vi.advanceTimersByTimeAsync(10_000);
    const outcomes = await Promise.all(waiting);
    expect(outcomes.every((o) => mod.isStripeBusyError(o))).toBe(true);

    for (const g of gates) g.resolve("done");
    await Promise.all(running);
    expect(mod.getStripeConcurrencyForTests()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it("queues calls past the limit and starts them as slots free up", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 2, maxWaiting: 5, maxWaitMs: 10_000 });
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const calls = gates.map((g, i) =>
      mod.withStripeCircuit(() => {
        started.push(i);
        return g.promise;
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1]);
    expect(mod.getStripeConcurrencyForTests()).toEqual({ inFlight: 2, waiting: 1 });

    gates[0].resolve("r0");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve("r1");
    gates[2].resolve("r2");
    await expect(Promise.all(calls)).resolves.toEqual(["r0", "r1", "r2"]);
  });

  it("fails with a busy error when the queue is full, and never touches the breaker", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 1, maxWaitMs: 10_000 });
    const gate = deferred();
    const action = vi.fn(async () => "never");

    const holder = mod.withStripeCircuit(() => gate.promise);
    const queued = mod.withStripeCircuit(async () => "queued");
    await vi.advanceTimersByTimeAsync(0);
    const firesBefore = mod.getCircuitBreakerStates().stripe.fires;

    // Far more refusals than the breaker's five-failure trip point.
    for (let i = 0; i < 12; i++) {
      await expect(mod.withStripeCircuit(action)).rejects.toSatisfy(mod.isStripeBusyError);
    }

    const state = mod.getCircuitBreakerStates().stripe;
    expect(action).not.toHaveBeenCalled();
    expect(state.fires).toBe(firesBefore);
    expect(state.failures).toBe(0);
    expect(state.rejects).toBe(0);
    expect(state.open).toBe(false);

    gate.resolve("done");
    await holder;
    await expect(queued).resolves.toBe("queued");
  });

  it("fails with a busy error after the wait limit, and never touches the breaker", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 50, maxWaitMs: 10_000 });
    const gate = deferred();

    const holder = mod.withStripeCircuit(() => gate.promise);
    const waiters = Array.from({ length: 8 }, () =>
      mod.withStripeCircuit(async () => "never").catch((e: unknown) => e)
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mod.getStripeConcurrencyForTests().waiting).toBe(8);
    await vi.advanceTimersByTimeAsync(1);

    const outcomes = await Promise.all(waiters);
    expect(outcomes.every((o) => mod.isStripeBusyError(o))).toBe(true);
    expect(mod.getStripeConcurrencyForTests().waiting).toBe(0);

    const state = mod.getCircuitBreakerStates().stripe;
    expect(state.failures).toBe(0);
    expect(state.timeouts).toBe(0);
    expect(state.open).toBe(false);

    // Eight busy errors in a row did not open the circuit: a real call still goes through.
    gate.resolve("done");
    await holder;
    await expect(mod.withStripeCircuit(async () => "ok")).resolves.toBe("ok");
  });

  it("does not run the opossum call timeout while a call waits", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 5, maxWaitMs: 60_000 });
    const first = deferred();
    const second = deferred();

    // Each call runs for 20 s, inside the breaker's 25 s limit; the third waits 40 s in total.
    const a = mod.withStripeCircuit(() => first.promise);
    const b = mod.withStripeCircuit(() => second.promise);
    const c = mod.withStripeCircuit(async () => "waited 40 s, ran instantly");
    await vi.advanceTimersByTimeAsync(20_000);
    first.resolve("a");
    await vi.advanceTimersByTimeAsync(20_000);
    second.resolve("b");

    await expect(Promise.all([a, b, c])).resolves.toEqual(["a", "b", "waited 40 s, ran instantly"]);
    const state = mod.getCircuitBreakerStates().stripe;
    expect(state.timeouts).toBe(0);
    expect(state.failures).toBe(0);
  });

  it("releases the slot after a successful call", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 1000 });
    await expect(mod.withStripeCircuit(async () => "a")).resolves.toBe("a");
    expect(mod.getStripeConcurrencyForTests().inFlight).toBe(0);
    await expect(mod.withStripeCircuit(async () => "b")).resolves.toBe("b");
  });

  it("releases the slot after a failed call, and still counts that failure", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 1000 });

    await expect(
      mod.withStripeCircuit(() => Promise.reject(stripeError("StripeAPIError", 500)))
    ).rejects.toThrow("StripeAPIError message");
    expect(mod.getStripeConcurrencyForTests().inFlight).toBe(0);
    expect(mod.getCircuitBreakerStates().stripe.failures).toBe(1);

    // A caller error also frees the slot.
    await expect(
      mod.withStripeCircuit(() => Promise.reject(stripeError("StripeInvalidRequestError", 400)))
    ).rejects.toThrow("StripeInvalidRequestError message");
    expect(mod.getStripeConcurrencyForTests().inFlight).toBe(0);
    await expect(mod.withStripeCircuit(async () => "next")).resolves.toBe("next");
  });

  it("reports an open circuit, not a busy error, for calls that waited while it opened", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 5, maxWaitMs: 10_000 });
    const gate = deferred();

    const holder = mod.withStripeCircuit(() => gate.promise);
    const waiter = mod.withStripeCircuit(async () => "never").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);

    mod.openStripeCircuitForTests();
    gate.resolve("done");
    await holder;

    const error = await waiter;
    expect(mod.isCircuitOpenError(error)).toBe(true);
    expect(mod.isStripeBusyError(error)).toBe(false);
    // And the slot was released.
    expect(mod.getStripeConcurrencyForTests().inFlight).toBe(0);
  });

  it("answers an already-open circuit at once instead of queueing behind other calls", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 5, maxWaitMs: 10_000 });
    const gate = deferred();
    const holder = mod.withStripeCircuit(() => gate.promise);
    await vi.advanceTimersByTimeAsync(0);

    mod.openStripeCircuitForTests();
    await expect(mod.withStripeCircuit(async () => "x")).rejects.toSatisfy(mod.isCircuitOpenError);
    expect(mod.getStripeConcurrencyForTests().waiting).toBe(0);

    gate.resolve("done");
    await holder;
  });

  it("restores the default limits", async () => {
    const mod = await load();
    mod.configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 1 });
    mod.resetStripeConcurrencyForTests();
    const gates = Array.from({ length: 3 }, () => deferred());
    const calls = gates.map((g) => mod.withStripeCircuit(() => g.promise));
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.getStripeConcurrencyForTests()).toEqual({ inFlight: 3, waiting: 0 });
    for (const g of gates) g.resolve("done");
    await Promise.all(calls);
  });
});
