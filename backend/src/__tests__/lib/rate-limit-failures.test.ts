import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const START = new Date("2026-01-01T00:00:00Z");

function makeRequest(ip = "10.0.0.1") {
  return {
    ip,
    method: "GET",
    headers: {},
    routeOptions: { url: "/status" },
    log: { error: vi.fn() },
  };
}

describe("failureRateLimit (in-memory)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function load() {
    return import("../../lib/rate-limit");
  }

  it("does not block until max failures have been recorded", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000 });
    const request = makeRequest();

    for (let i = 0; i < 3; i++) {
      expect(await limiter.check(request as any)).toEqual({ blocked: false });
      await limiter.record(request as any);
    }
    expect(await limiter.check(request as any)).toEqual({ blocked: true, retryAfterMs: 60_000 });
  });

  it("checking never charges", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
    const request = makeRequest();

    for (let i = 0; i < 20; i++) {
      expect(await limiter.check(request as any)).toEqual({ blocked: false });
    }
    await limiter.record(request as any);
    expect((await limiter.check(request as any)).blocked).toBe(true);
  });

  it("reports the time until the oldest failure leaves the window", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 2, windowMs: 60_000 });
    const request = makeRequest();

    await limiter.record(request as any);
    vi.setSystemTime(new Date(START.getTime() + 10_000));
    await limiter.record(request as any);
    vi.setSystemTime(new Date(START.getTime() + 25_000));

    expect(await limiter.check(request as any)).toEqual({ blocked: true, retryAfterMs: 35_000 });
  });

  it("unblocks as failures age out of the window", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 2, windowMs: 60_000 });
    const request = makeRequest();

    await limiter.record(request as any);
    await limiter.record(request as any);
    expect((await limiter.check(request as any)).blocked).toBe(true);

    vi.setSystemTime(new Date(START.getTime() + 60_001));
    expect(await limiter.check(request as any)).toEqual({ blocked: false });
  });

  it("keeps separate budgets per IP and per name", async () => {
    const { failureRateLimit } = await load();
    const one = failureRateLimit({ max: 1, windowMs: 60_000, name: "one" });
    const two = failureRateLimit({ max: 1, windowMs: 60_000, name: "two" });

    await one.record(makeRequest("10.0.0.1") as any);
    expect((await one.check(makeRequest("10.0.0.1") as any)).blocked).toBe(true);
    expect((await one.check(makeRequest("10.0.0.2") as any)).blocked).toBe(false);
    expect((await two.check(makeRequest("10.0.0.1") as any)).blocked).toBe(false);
  });

  it("does not share hits with a rateLimit on the same route", async () => {
    const { failureRateLimit, rateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000, name: "failures" });
    const guard = rateLimit({ max: 1, windowMs: 60_000 });
    const request = makeRequest();
    const reply = {
      code: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    await guard(request as any, reply as any);
    expect((await limiter.check(request as any)).blocked).toBe(false);
  });
});

describe("failureRateLimit (Redis)", () => {
  let mockPipeline: any;
  let mockRedis: any;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    mockPipeline = {
      zremrangebyscore: vi.fn(),
      zcard: vi.fn(),
      zrange: vi.fn(),
      zadd: vi.fn(),
      pexpire: vi.fn(),
      exec: vi.fn(),
    };
    mockRedis = {
      pipeline: vi.fn().mockReturnValue(mockPipeline),
      on: vi.fn(),
      connect: vi.fn(),
    };
    vi.doMock("ioredis", () => ({
      // biome-ignore lint/complexity/useArrowFunction: vitest 4 requires a constructable (non-arrow) implementation for mocks called with `new`
      default: vi.fn().mockImplementation(function () {
        return mockRedis;
      }),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.REDIS_URL;
  });

  async function load() {
    process.env.REDIS_URL = "redis://localhost:6379";
    return import("../../lib/rate-limit");
  }

  it("check reads the window without adding a hit", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 2],
      [null, []],
    ]);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000 });

    expect(await limiter.check(makeRequest() as any)).toEqual({ blocked: false });
    expect(mockPipeline.zremrangebyscore).toHaveBeenCalledTimes(1);
    expect(mockPipeline.zcard).toHaveBeenCalledTimes(1);
    expect(mockPipeline.zadd).not.toHaveBeenCalled();
  });

  it("check blocks at max with Retry-After from the oldest hit's score", async () => {
    const oldest = START.getTime() - 20_000;
    mockPipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 3],
      [null, ["member", String(oldest)]],
    ]);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000 });

    expect(await limiter.check(makeRequest() as any)).toEqual({
      blocked: true,
      retryAfterMs: 40_000,
    });
  });

  it("check degrades to the full window when the oldest hit cannot be read", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 3],
      [null, []],
    ]);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000 });

    expect(await limiter.check(makeRequest() as any)).toEqual({
      blocked: true,
      retryAfterMs: 60_000,
    });
  });

  it("record adds one hit and sets the key expiry", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 1],
      [null, 1],
    ]);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({
      max: 3,
      windowMs: 60_000,
      name: "failed-auth",
      keyGenerator: () => "ip-1",
    });

    await limiter.record(makeRequest() as any);
    expect(mockPipeline.zadd).toHaveBeenCalledTimes(1);
    expect(mockPipeline.zadd.mock.calls[0][0]).toBe("ratelimit:failed-auth:ip-1");
    expect(mockPipeline.pexpire).toHaveBeenCalledWith("ratelimit:failed-auth:ip-1", 60_000);
  });

  it("falls back to in-memory counting when Redis fails, logging the error", async () => {
    mockPipeline.exec.mockRejectedValue(new Error("Redis connection lost"));
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 2, windowMs: 60_000 });
    const request = makeRequest();

    await limiter.record(request as any);
    await limiter.record(request as any);
    expect((await limiter.check(request as any)).blocked).toBe(true);
    expect(request.log.error).toHaveBeenCalled();
  });

  it("falls back to memory when a pipeline command reports an error", async () => {
    mockPipeline.exec.mockResolvedValue([
      [new Error("READONLY"), null],
      [null, null],
      [null, null],
    ]);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });

    expect(await limiter.check(makeRequest() as any)).toEqual({ blocked: false });
  });
});
