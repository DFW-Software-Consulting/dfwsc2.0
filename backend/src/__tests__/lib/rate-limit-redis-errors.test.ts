import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ioredis resolves pipeline.exec() with per-command errors instead of rejecting
// when the connection is down, so these tests feed that exact shape.
const connectionClosed = () => [
  [new Error("Connection is closed."), undefined],
  [new Error("Connection is closed."), undefined],
  [new Error("Connection is closed."), undefined],
  [new Error("Connection is closed."), undefined],
];

describe("rateLimit - Redis per-command errors", () => {
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    exec = vi.fn();
    const pipeline: any = {
      zremrangebyscore: vi.fn(),
      zcard: vi.fn(),
      zadd: vi.fn(),
      pexpire: vi.fn(),
      exec,
    };
    vi.doMock("ioredis", () => ({
      // biome-ignore lint/complexity/useArrowFunction: vitest requires a constructable (non-arrow) implementation for mocks called with `new`
      default: vi.fn().mockImplementation(function () {
        return { on: vi.fn(), pipeline: vi.fn(() => pipeline), zremrangebyscore: vi.fn() };
      }),
    }));
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.useRealTimers();
  });

  function makeMocks() {
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    const request = {
      ip: "127.0.0.1",
      method: "POST",
      headers: {},
      routeOptions: { url: "/auth/login" },
      log: { error: vi.fn() },
    };
    return { request, reply };
  }

  it("enforces limits in memory instead of letting everything through", async () => {
    exec.mockResolvedValue(connectionClosed());
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 2, windowMs: 60_000 });

    const outcomes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { request, reply } = makeMocks();
      await guard(request as any, reply as any);
      outcomes.push(reply.code.mock.calls[0]?.[0] ?? 200);
    }
    expect(outcomes).toEqual([200, 200, 429, 429]);
  });

  it("does not reject with 503 while Redis is down", async () => {
    exec.mockResolvedValue(connectionClosed());
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 5, windowMs: 60_000 });
    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("logs the Redis error, throttled to one line per interval", async () => {
    exec.mockResolvedValue(connectionClosed());
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 100, windowMs: 60_000 });

    const first = makeMocks();
    await guard(first.request as any, first.reply as any);
    expect(first.request.log.error).toHaveBeenCalledTimes(1);
    expect(first.request.log.error.mock.calls[0][0].err.message).toBe("Connection is closed.");

    const second = makeMocks();
    await guard(second.request as any, second.reply as any);
    expect(second.request.log.error).not.toHaveBeenCalled();

    vi.advanceTimersByTime(31_000);
    const third = makeMocks();
    await guard(third.request as any, third.reply as any);
    expect(third.request.log.error).toHaveBeenCalledTimes(1);
  });

  it("returns to Redis-backed limiting once commands succeed again", async () => {
    exec.mockResolvedValueOnce(connectionClosed());
    exec.mockResolvedValue([
      [null, 0],
      [null, 5],
      [null, 1],
      [null, 1],
    ]);
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 5, windowMs: 60_000 });

    const down = makeMocks();
    await guard(down.request as any, down.reply as any);
    expect(down.reply.code).not.toHaveBeenCalled();

    const up = makeMocks();
    await guard(up.request as any, up.reply as any);
    expect(up.reply.code).toHaveBeenCalledWith(429);
  });
});
