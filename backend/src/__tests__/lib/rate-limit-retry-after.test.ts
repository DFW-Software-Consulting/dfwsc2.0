import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every refusal from the sliding-window limiter must say when to retry: a Retry-After in
// whole seconds (at least 1) and a stable machine-readable code.

const START = new Date("2026-01-01T00:00:00Z");

function makeMocks(ip = "10.0.0.1") {
  const reply = {
    code: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const request = {
    ip,
    method: "GET",
    headers: {},
    routeOptions: { url: "/retry-after-test" },
    log: { error: vi.fn() },
  };
  return { request, reply };
}

describe("sliding-window rateLimit Retry-After (in-memory)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends 429 with the RATE_LIMITED body and the time until the oldest hit expires", async () => {
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 2, windowMs: 60_000 });

    await guard(makeMocks().request as any, makeMocks().reply as any); // t=0
    vi.advanceTimersByTime(10_000);
    await guard(makeMocks().request as any, makeMocks().reply as any); // t=10s
    vi.advanceTimersByTime(10_000);

    const { request, reply } = makeMocks();
    await guard(request as any, reply as any); // t=20s: oldest hit leaves at t=60s
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.header).toHaveBeenCalledWith("Retry-After", "40");
    expect(reply.send).toHaveBeenCalledWith({ error: "Too Many Requests", code: "RATE_LIMITED" });
  });

  it("rounds a partial second up and never sends less than 1", async () => {
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 1, windowMs: 60_000 });

    await guard(makeMocks().request as any, makeMocks().reply as any);
    vi.advanceTimersByTime(59_500); // the only hit leaves the window in 500 ms

    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);
    expect(reply.header).toHaveBeenCalledWith("Retry-After", "1");
  });

  it("allows the request once the advertised wait has elapsed", async () => {
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 1, windowMs: 60_000 });

    await guard(makeMocks().request as any, makeMocks().reply as any);
    vi.advanceTimersByTime(20_000);
    const refused = makeMocks();
    await guard(refused.request as any, refused.reply as any);
    const waitSeconds = Number(refused.reply.header.mock.calls[0][1]);
    expect(waitSeconds).toBe(40);

    vi.advanceTimersByTime(waitSeconds * 1000);
    const retry = makeMocks();
    await guard(retry.request as any, retry.reply as any);
    expect(retry.reply.code).not.toHaveBeenCalled();
  });

  it("does not add headers to allowed requests", async () => {
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 1, windowMs: 60_000 });
    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);
    expect(reply.header).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});

describe("sliding-window rateLimit Retry-After (Redis)", () => {
  let exec: ReturnType<typeof vi.fn>;
  let zrange: ReturnType<typeof vi.fn>;
  let zremrangebyscore: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    exec = vi.fn();
    zrange = vi.fn();
    zremrangebyscore = vi.fn().mockResolvedValue(1);
    const pipeline = {
      zremrangebyscore: vi.fn(),
      zcard: vi.fn(),
      zadd: vi.fn(),
      pexpire: vi.fn(),
      exec,
    };
    vi.doMock("ioredis", () => ({
      // biome-ignore lint/complexity/useArrowFunction: vitest requires a constructable (non-arrow) implementation for mocks called with `new`
      default: vi.fn().mockImplementation(function () {
        return { on: vi.fn(), pipeline: vi.fn(() => pipeline), zremrangebyscore, zrange };
      }),
    }));
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.useRealTimers();
  });

  const overLimit = () => [
    [null, 0],
    [null, 2],
    [null, 1],
    [null, 1],
  ];

  it("derives Retry-After from the oldest hit still in the sorted set", async () => {
    exec.mockResolvedValue(overLimit());
    zrange.mockResolvedValue(["member", String(START.getTime() - 25_000)]);
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 2, windowMs: 60_000 });

    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);

    expect(zrange).toHaveBeenCalledWith(expect.stringContaining("ratelimit:"), 0, 0, "WITHSCORES");
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.header).toHaveBeenCalledWith("Retry-After", "35");
    expect(reply.send).toHaveBeenCalledWith({ error: "Too Many Requests", code: "RATE_LIMITED" });
  });

  it("falls back to the full window when the oldest hit cannot be read, still refusing", async () => {
    exec.mockResolvedValue(overLimit());
    zrange.mockRejectedValue(new Error("Connection is closed."));
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 2, windowMs: 60_000 });

    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);

    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.header).toHaveBeenCalledWith("Retry-After", "60");
  });
});
