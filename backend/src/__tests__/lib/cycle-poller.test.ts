import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCyclePoller } from "../../lib/cycle-poller";

describe("createCyclePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("runs a cycle on trigger and on every interval tick", async () => {
    const cycle = vi.fn(async () => undefined);
    const poller = createCyclePoller({
      logger: { error: vi.fn() },
      cycle,
      intervalMs: 1000,
      crashMessage: "crashed",
    });
    poller.trigger();
    expect(cycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycle).toHaveBeenCalledTimes(2);
    await poller.stop();
  });

  it("queues exactly one follow-up for triggers during a running cycle", async () => {
    const first = deferred();
    const cycle = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const poller = createCyclePoller({
      logger: { error: vi.fn() },
      cycle,
      intervalMs: 60_000,
      crashMessage: "crashed",
    });
    poller.trigger();
    poller.trigger();
    poller.trigger();
    expect(cycle).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(2);
    await poller.stop();
  });

  it("logs the crash message with the error name only and keeps polling", async () => {
    const error = vi.fn();
    const cycle = vi.fn().mockRejectedValueOnce(new TypeError("secret detail"));
    const poller = createCyclePoller({
      logger: { error },
      cycle,
      intervalMs: 1000,
      crashMessage: "Cycle crashed.",
    });
    poller.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith({ errorName: "TypeError" }, "Cycle crashed.");
    cycle.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycle).toHaveBeenCalledTimes(2);
    await poller.stop();
  });

  it("stop() clears the timer, runs onStop, waits for the running cycle and blocks new ones", async () => {
    const running = deferred();
    const cycle = vi.fn(() => running.promise);
    const onStop = vi.fn();
    const poller = createCyclePoller({
      logger: { error: vi.fn() },
      cycle,
      intervalMs: 1000,
      crashMessage: "crashed",
      onStop,
    });
    poller.trigger();
    poller.trigger(); // queued follow-up must be dropped once stopped
    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped).toBe(false);
    running.resolve();
    await stopping;
    poller.trigger();
    expect(cycle).toHaveBeenCalledTimes(1);
  });
});
