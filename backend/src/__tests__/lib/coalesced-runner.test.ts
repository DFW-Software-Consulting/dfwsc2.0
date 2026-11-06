import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescedRunner, kickJob, registerKickable } from "../../lib/coalesced-runner";

const logger = { error: vi.fn() };

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  logger.error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createCoalescedRunner", () => {
  it("collapses a burst into one running cycle plus one follow-up", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const cycle = vi.fn().mockImplementation(() => gates[cycle.mock.calls.length - 1].promise);
    const runner = createCoalescedRunner({ name: "t", logger, cycle });

    for (let i = 0; i < 10; i++) runner.trigger();
    expect(cycle).toHaveBeenCalledTimes(1);

    gates[0].resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(2);

    gates[1].resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(2);
    await runner.stop();
  });

  it("debounces kick() so a burst becomes one cycle", async () => {
    const cycle = vi.fn().mockResolvedValue(undefined);
    const runner = createCoalescedRunner({ name: "t", logger, cycle, debounceMs: 1500 });
    for (let i = 0; i < 5; i++) runner.kick();
    expect(cycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1499);
    expect(cycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cycle).toHaveBeenCalledTimes(1);
    await runner.stop();
  });

  it("retries a busy cycle once after the delay, not forever", async () => {
    const cycle = vi.fn().mockResolvedValue({ status: "busy" });
    const runner = createCoalescedRunner({
      name: "t",
      logger,
      cycle,
      isBusy: (r) => (r as { status: string }).status === "busy",
      busyRetryMs: 5000,
    });
    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(cycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cycle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cycle).toHaveBeenCalledTimes(2);
    await runner.stop();
  });

  it("does not retry when the cycle was not busy", async () => {
    const cycle = vi.fn().mockResolvedValue({ status: "ok" });
    const runner = createCoalescedRunner({
      name: "t",
      logger,
      cycle,
      isBusy: (r) => (r as { status: string }).status === "busy",
    });
    runner.trigger();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cycle).toHaveBeenCalledTimes(1);
    await runner.stop();
  });

  it("a trigger during the busy wait runs at once instead of waiting", async () => {
    const cycle = vi.fn().mockResolvedValueOnce({ status: "busy" }).mockResolvedValue({});
    const runner = createCoalescedRunner({
      name: "t",
      logger,
      cycle,
      isBusy: (r) => (r as { status?: string }).status === "busy",
    });
    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);
    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cycle).toHaveBeenCalledTimes(2);
    await runner.stop();
  });

  it("logs a crashing cycle instead of throwing, and keeps working", async () => {
    const cycle = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const runner = createCoalescedRunner({ name: "t", logger, cycle });
    expect(() => runner.trigger()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    runner.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(2);
    await runner.stop();
  });

  it("does nothing after stop()", async () => {
    const cycle = vi.fn().mockResolvedValue(undefined);
    const runner = createCoalescedRunner({ name: "t", logger, cycle, debounceMs: 100 });
    runner.kick();
    await runner.stop();
    runner.trigger();
    runner.kick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycle).not.toHaveBeenCalled();
  });
});

describe("kickJob", () => {
  it("is a no-op when the job is not started", () => {
    expect(() => kickJob("salesLead")).not.toThrow();
  });

  it("kicks the registered runner and stops once unregistered", () => {
    const runner = { trigger: vi.fn(), kick: vi.fn(), stop: vi.fn() };
    const unregister = registerKickable("portalMirror", runner);
    kickJob("portalMirror");
    expect(runner.kick).toHaveBeenCalledTimes(1);
    unregister();
    kickJob("portalMirror");
    expect(runner.kick).toHaveBeenCalledTimes(1);
  });

  it("never throws into the caller", () => {
    const runner = {
      trigger: vi.fn(),
      kick: vi.fn(() => {
        throw new Error("boom");
      }),
      stop: vi.fn(),
    };
    const unregister = registerKickable("billingMirror", runner);
    expect(() => kickJob("billingMirror")).not.toThrow();
    unregister();
  });
});
