import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

describe("rateLimit - in-memory fallback (no REDIS_URL)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
  });

  async function getRateLimit() {
    vi.resetModules();
    delete process.env.REDIS_URL;
    const mod = await import("../../lib/rate-limit");
    return mod.rateLimit;
  }

  function makeMocks(ip = "127.0.0.1") {
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const request = { ip, headers: {} };
    return { request, reply };
  }

  it("allows requests up to max without blocking", async () => {
    const rateLimit = await getRateLimit();
    const guard = rateLimit({ max: 3, windowMs: 60_000 });
    const { request, reply } = makeMocks();
    for (let i = 0; i < 3; i++) {
      await guard(request as any, reply as any);
    }
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("returns 429 when max is exceeded", async () => {
    const rateLimit = await getRateLimit();
    const guard = rateLimit({ max: 2, windowMs: 60_000 });
    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);
    await guard(request as any, reply as any);
    await guard(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({ error: "Too Many Requests" });
  });
});

describe("rateLimit - Redis path", () => {
  let mockPipeline: any;
  let mockRedis: any;

  beforeEach(() => {
    vi.resetModules();
    mockPipeline = {
      zremrangebyscore: vi.fn(),
      zcard: vi.fn(),
      zadd: vi.fn(),
      pexpire: vi.fn(),
      exec: vi.fn(),
    };
    mockRedis = {
      pipeline: vi.fn().mockReturnValue(mockPipeline),
      zremrangebyscore: vi.fn(),
      on: vi.fn(),
      connect: vi.fn(),
    };
    vi.doMock("ioredis", () => ({
      default: vi.fn().mockImplementation(() => mockRedis),
    }));
  });

  async function getRateLimit() {
    process.env.REDIS_URL = "redis://localhost:6379";
    const mod = await import("../../lib/rate-limit");
    return mod.rateLimit;
  }

  function makeMocks(ip = "127.0.0.1") {
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const request = { ip, headers: {} };
    return { request, reply };
  }

  it("allows requests when Redis says under limit", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 0],
      [null, "OK"],
      [null, true],
    ]);
    const rateLimit = await getRateLimit();
    const guard = rateLimit({ max: 5, windowMs: 60_000 });
    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("returns 429 when Redis says over limit", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 5],
      [null, "OK"],
      [null, true],
    ]);
    const rateLimit = await getRateLimit();
    const guard = rateLimit({ max: 5, windowMs: 60_000 });
    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(429);
  });

  it("falls back to in-memory when Redis pipeline fails", async () => {
    mockPipeline.exec.mockRejectedValue(new Error("Redis connection lost"));
    const rateLimit = await getRateLimit();
    const guard = rateLimit({ max: 2, windowMs: 60_000 });
    const { request, reply } = makeMocks();
    await guard(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
    await guard(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
    await guard(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(429);
  });
});

describe("rateLimit - startup warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns once at module load when REDIS_URL is unset", async () => {
    delete process.env.REDIS_URL;

    await import("../../lib/rate-limit");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0];
    expect(message).toMatch(/REDIS_URL/);
    expect(message).toMatch(/in-memory/i);
    expect(message).toMatch(/replica/i);
  });

  it("does not warn at module load when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("ioredis", () => ({
      default: vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        pipeline: vi.fn(),
      })),
    }));

    try {
      await import("../../lib/rate-limit");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.REDIS_URL;
    }
  });
});
