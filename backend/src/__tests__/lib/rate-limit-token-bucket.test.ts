import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const START = new Date("2026-01-01T00:00:00Z");

function makeMocks(opts: { ip?: string; url?: string; method?: string } = {}) {
  const reply = {
    code: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const request = {
    ip: opts.ip ?? "10.0.0.1",
    method: opts.method ?? "POST",
    headers: {},
    routeOptions: { url: opts.url ?? "/payments/create" },
    log: { error: vi.fn() },
  };
  return { request, reply };
}

type Guard = (request: any, reply: any) => Promise<unknown>;

// Returns true when the request was admitted, false when it was refused with a 429.
async function take(guard: Guard, opts: Parameters<typeof makeMocks>[0] = {}) {
  const { request, reply } = makeMocks(opts);
  await guard(request, reply);
  return { admitted: reply.code.mock.calls.length === 0, reply };
}

describe("tokenBucketRateLimit (in-memory)", () => {
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

  it("admits a full burst up to capacity, then refuses with 429, code and Retry-After", async () => {
    const { tokenBucketRateLimit } = await load();
    const guard = tokenBucketRateLimit({ capacity: 5, refillPerMinute: 60 });

    for (let i = 0; i < 5; i++) expect((await take(guard)).admitted).toBe(true);

    const refused = await take(guard);
    expect(refused.admitted).toBe(false);
    expect(refused.reply.code).toHaveBeenCalledWith(429);
    expect(refused.reply.header).toHaveBeenCalledWith("Retry-After", "1");
    expect(refused.reply.send).toHaveBeenCalledWith({
      error: "Too Many Requests",
      code: "RATE_LIMITED",
    });
  });

  it("refills continuously at the configured rate", async () => {
    const { tokenBucketRateLimit } = await load();
    const guard = tokenBucketRateLimit({ capacity: 5, refillPerMinute: 60 }); // 1 per second

    for (let i = 0; i < 5; i++) await take(guard);
    expect((await take(guard)).admitted).toBe(false);

    vi.advanceTimersByTime(3000);
    for (let i = 0; i < 3; i++) expect((await take(guard)).admitted).toBe(true);
    expect((await take(guard)).admitted).toBe(false);
  });

  it("never holds more than capacity, however long it sat idle", async () => {
    const { tokenBucketRateLimit } = await load();
    const guard = tokenBucketRateLimit({ capacity: 3, refillPerMinute: 60 });

    await take(guard);
    vi.advanceTimersByTime(60 * 60_000);

    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) outcomes.push((await take(guard)).admitted);
    expect(outcomes).toEqual([true, true, true, false, false]);
  });

  it("sends Retry-After as the time until one token is available, rounded up", async () => {
    const { tokenBucketRateLimit } = await load();
    const guard = tokenBucketRateLimit({ capacity: 2, refillPerMinute: 6 }); // one per 10 s

    await take(guard);
    await take(guard);

    const first = await take(guard);
    expect(first.reply.header).toHaveBeenCalledWith("Retry-After", "10");

    vi.advanceTimersByTime(4000); // 0.4 of a token back: 6 s to go
    const second = await take(guard);
    expect(second.reply.header).toHaveBeenCalledWith("Retry-After", "6");

    vi.advanceTimersByTime(5500); // 0.95 of a token: 0.5 s to go, never advertised as 0
    const third = await take(guard);
    expect(third.reply.header).toHaveBeenCalledWith("Retry-After", "1");
  });

  it("admits the retry once the advertised wait has elapsed", async () => {
    const { tokenBucketRateLimit } = await load();
    const guard = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 12 }); // one per 5 s

    await take(guard);
    vi.advanceTimersByTime(1000);
    const refused = await take(guard);
    const wait = Number(refused.reply.header.mock.calls[0][1]);
    expect(wait).toBe(4);

    vi.advanceTimersByTime(wait * 1000);
    expect((await take(guard)).admitted).toBe(true);
  });

  it("does not add headers to admitted requests", async () => {
    const { tokenBucketRateLimit } = await load();
    const guard = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 60 });
    const { admitted, reply } = await take(guard);
    expect(admitted).toBe(true);
    expect(reply.header).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("keeps one bucket per key from keyGenerator", async () => {
    const { tokenBucketRateLimit } = await load();
    const guard = tokenBucketRateLimit({
      capacity: 2,
      refillPerMinute: 60,
      keyGenerator: (req) => req.headers["x-test-key"] as string,
    });

    const as = async (key: string) => {
      const { request, reply } = makeMocks();
      request.headers = { "x-test-key": key } as any;
      await guard(request as any, reply as any);
      return reply.code.mock.calls.length === 0;
    };

    expect(await as("stripe:acct_A")).toBe(true);
    expect(await as("stripe:acct_A")).toBe(true);
    expect(await as("stripe:acct_A")).toBe(false);
    // Another building is unaffected by acct_A being drained.
    expect(await as("stripe:acct_B")).toBe(true);
  });

  it("namespaces buckets per route, or by an explicit name", async () => {
    const { tokenBucketRateLimit } = await load();
    const a = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 60 });
    const b = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 60 });
    const named = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 60, name: "custom" });

    expect((await take(a, { url: "/one" })).admitted).toBe(true);
    expect((await take(a, { url: "/one" })).admitted).toBe(false);
    // Same client, different route: separate bucket.
    expect((await take(b, { url: "/two" })).admitted).toBe(true);
    // An explicit name ignores the route entirely.
    expect((await take(named, { url: "/one" })).admitted).toBe(true);
    expect((await take(named, { url: "/two" })).admitted).toBe(false);
  });

  it("does not share state with the sliding-window limiter", async () => {
    const { tokenBucketRateLimit, rateLimit } = await load();
    const bucket = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 60 });
    const window = rateLimit({ max: 1, windowMs: 60_000 });

    expect((await take(bucket)).admitted).toBe(true);
    expect((await take(window)).admitted).toBe(true);
    expect((await take(bucket)).admitted).toBe(false);
    expect((await take(window)).admitted).toBe(false);
  });

  it("rejects a nonsensical configuration up front", async () => {
    const { tokenBucketRateLimit } = await load();
    expect(() => tokenBucketRateLimit({ capacity: 0, refillPerMinute: 60 })).toThrow();
    expect(() => tokenBucketRateLimit({ capacity: 5, refillPerMinute: 0 })).toThrow();
  });

  it("sweeps buckets that have fully refilled so the map stays bounded", async () => {
    const { tokenBucketRateLimit, tokenBuckets } = await load();
    const guard = tokenBucketRateLimit({ capacity: 2, refillPerMinute: 60 }); // full in 2 s
    await take(guard, { ip: "10.0.0.1" });
    await take(guard, { ip: "10.0.0.2" });
    expect(tokenBuckets.size).toBe(2);

    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(tokenBuckets.size).toBe(0);
  });
});

describe("tokenBucketRateLimit (Redis path, mocked client)", () => {
  let evalMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    evalMock = vi.fn();
    vi.doMock("ioredis", () => ({
      // biome-ignore lint/complexity/useArrowFunction: vitest requires a constructable (non-arrow) implementation for mocks called with `new`
      default: vi.fn().mockImplementation(function () {
        return { on: vi.fn(), eval: evalMock };
      }),
    }));
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.useRealTimers();
  });

  it("runs the Lua script against a route-namespaced key with capacity, rate and TTL", async () => {
    evalMock.mockResolvedValue([1, 0]);
    const { tokenBucketRateLimit, TOKEN_BUCKET_LUA } = await import("../../lib/rate-limit");
    const guard = tokenBucketRateLimit({
      capacity: 200,
      refillPerMinute: 120,
      keyGenerator: () => "stripe:acct_A",
    });

    const { admitted } = await take(guard, { url: "/payments/create" });
    expect(admitted).toBe(true);
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, capacity, refillPerMs, ttl] = evalMock.mock.calls[0];
    expect(script).toBe(TOKEN_BUCKET_LUA);
    expect(numKeys).toBe(1);
    expect(key).toBe("ratelimit:bucket:POST:/payments/create:stripe:acct_A");
    expect(capacity).toBe("200");
    expect(Number(refillPerMs)).toBeCloseTo(0.002, 10);
    // Full refill takes 100 s; the key lives that long plus a second of slack.
    expect(ttl).toBe("101000");
  });

  it("turns a refusal from the script into 429 with the script's wait, in whole seconds", async () => {
    evalMock.mockResolvedValue([0, 1500]);
    const { tokenBucketRateLimit } = await import("../../lib/rate-limit");
    const guard = tokenBucketRateLimit({ capacity: 200, refillPerMinute: 120 });

    const { admitted, reply } = await take(guard);
    expect(admitted).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.header).toHaveBeenCalledWith("Retry-After", "2");
    expect(reply.send).toHaveBeenCalledWith({ error: "Too Many Requests", code: "RATE_LIMITED" });
  });

  it("falls back to an in-memory bucket when Redis errors, logging once per interval", async () => {
    evalMock.mockRejectedValue(new Error("Connection is closed."));
    const { tokenBucketRateLimit } = await import("../../lib/rate-limit");
    const guard = tokenBucketRateLimit({ capacity: 2, refillPerMinute: 60 });

    const outcomes: boolean[] = [];
    const logs: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < 4; i++) {
      const { request, reply } = makeMocks();
      await guard(request as any, reply as any);
      outcomes.push(reply.code.mock.calls.length === 0);
      logs.push(request.log.error);
    }
    // Capacity 2 is still enforced, in memory, instead of failing open.
    expect(outcomes).toEqual([true, true, false, false]);
    expect(logs.filter((l) => l.mock.calls.length > 0)).toHaveLength(1);
  });

  it("treats an empty script reply as a Redis failure and uses memory", async () => {
    evalMock.mockResolvedValue(null);
    const { tokenBucketRateLimit } = await import("../../lib/rate-limit");
    const guard = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 60 });

    expect((await take(guard)).admitted).toBe(true);
    expect((await take(guard)).admitted).toBe(false);
  });
});
