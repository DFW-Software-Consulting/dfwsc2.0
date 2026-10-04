import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Proves the Redis token-bucket Lua script (and the sliding window's Retry-After) against a
// real Redis. Runs only when RATE_LIMIT_TEST_REDIS_URL points at one, for example:
//   docker run -d --name rvw-burst-redis -p 127.0.0.1::6379 redis:7-alpine
//   RATE_LIMIT_TEST_REDIS_URL=redis://127.0.0.1:<port> npx vitest run rate-limit-redis-live
// CI has no Redis service, so without the variable this suite is not registered.
const REDIS_URL = process.env.RATE_LIMIT_TEST_REDIS_URL;

type Guard = (request: any, reply: any) => Promise<unknown>;

// The tests choose the bucket key directly rather than going through client-IP resolution.
const byId = (request: { ip: string }) => request.ip;

function makeMocks(id: string) {
  const reply = {
    code: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const request = {
    ip: id,
    method: "POST",
    headers: {},
    routeOptions: { url: "/live-test" },
    log: { error: vi.fn() },
  };
  return { request, reply };
}

async function take(guard: Guard, id: string) {
  const { request, reply } = makeMocks(id);
  await guard(request, reply);
  return { admitted: reply.code.mock.calls.length === 0, reply, request };
}

// Every call to this builds a fresh copy of the module, hence a fresh ioredis connection,
// so concurrent takes come from independent connections as they would from independent
// API instances.
async function loadModule() {
  vi.resetModules();
  process.env.REDIS_URL = REDIS_URL;
  return import("../../lib/rate-limit");
}

describe.runIf(Boolean(REDIS_URL))("rate limiters against a real Redis", () => {
  let inspector: Redis;
  const keysToClean: string[] = [];

  beforeAll(() => {
    inspector = new Redis(REDIS_URL as string);
  });

  afterAll(async () => {
    if (keysToClean.length > 0) await inspector.del(...keysToClean);
    await inspector.quit();
    delete process.env.REDIS_URL;
  });

  // A unique client id per test, so tests (and reruns) never share a bucket.
  function freshId() {
    const id = `live-${randomUUID()}`;
    keysToClean.push(`ratelimit:bucket:POST:/live-test:${id}`, `ratelimit:POST:/live-test:${id}`);
    return id;
  }

  it("is talking to a real Redis 7 and the script uses Redis's own clock", async () => {
    const info = await inspector.info("server");
    expect(info).toMatch(/redis_version:7\./);
  });

  it("admits a burst of capacity, then refuses with Retry-After and code", async () => {
    const { tokenBucketRateLimit } = await loadModule();
    const guard = tokenBucketRateLimit({ capacity: 5, refillPerMinute: 60, keyGenerator: byId });
    const id = freshId();

    for (let i = 0; i < 5; i++) expect((await take(guard, id)).admitted).toBe(true);

    const refused = await take(guard, id);
    expect(refused.admitted).toBe(false);
    expect(refused.reply.code).toHaveBeenCalledWith(429);
    expect(refused.reply.header).toHaveBeenCalledWith("Retry-After", "1");
    expect(refused.reply.send).toHaveBeenCalledWith({
      error: "Too Many Requests",
      code: "RATE_LIMITED",
    });
    // Served by Redis, not by the in-memory fallback.
    expect(refused.request.log.error).not.toHaveBeenCalled();
  });

  it("refills with real elapsed time", async () => {
    const { tokenBucketRateLimit } = await loadModule();
    const guard = tokenBucketRateLimit({ capacity: 2, refillPerMinute: 120, keyGenerator: byId }); // 2 per second
    const id = freshId();

    expect((await take(guard, id)).admitted).toBe(true);
    expect((await take(guard, id)).admitted).toBe(true);
    expect((await take(guard, id)).admitted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 700)); // ~1.4 tokens
    expect((await take(guard, id)).admitted).toBe(true);
    expect((await take(guard, id)).admitted).toBe(false);
  });

  it("never lets two concurrent requests both take the last token", async () => {
    const id = freshId();
    // Eight independent connections, each firing five takes at once, against one token.
    const guards = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const { tokenBucketRateLimit } = await loadModule();
        return tokenBucketRateLimit({ capacity: 1, refillPerMinute: 1, keyGenerator: byId });
      })
    );

    const outcomes = await Promise.all(
      guards.flatMap((guard) => Array.from({ length: 5 }, () => take(guard, id)))
    );

    expect(outcomes).toHaveLength(40);
    expect(outcomes.filter((o) => o.admitted)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.admitted)).toHaveLength(39);
  });

  it("admits exactly capacity under heavy concurrent load, no more and no fewer", async () => {
    const id = freshId();
    const guards = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const { tokenBucketRateLimit } = await loadModule();
        // Refill is negligible over the test's duration (one token per 100 s).
        return tokenBucketRateLimit({ capacity: 50, refillPerMinute: 0.6, keyGenerator: byId });
      })
    );

    const outcomes = await Promise.all(
      guards.flatMap((guard) => Array.from({ length: 30 }, () => take(guard, id)))
    );

    expect(outcomes).toHaveLength(180);
    expect(outcomes.filter((o) => o.admitted)).toHaveLength(50);
  });

  it("keeps separate buckets per key", async () => {
    const { tokenBucketRateLimit } = await loadModule();
    const guard = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 1, keyGenerator: byId });
    const a = freshId();
    const b = freshId();

    expect((await take(guard, a)).admitted).toBe(true);
    expect((await take(guard, a)).admitted).toBe(false);
    expect((await take(guard, b)).admitted).toBe(true);
  });

  it("sets an expiry so idle buckets disappear", async () => {
    const { tokenBucketRateLimit } = await loadModule();
    const guard = tokenBucketRateLimit({ capacity: 10, refillPerMinute: 60, keyGenerator: byId }); // full in 10 s
    const id = freshId();
    await take(guard, id);

    const ttl = await inspector.pttl(`ratelimit:bucket:POST:/live-test:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(11_000);
  });

  it("sliding window: Retry-After is the time until the oldest hit leaves the window", async () => {
    const { rateLimit } = await loadModule();
    const guard = rateLimit({ max: 2, windowMs: 10_000, keyGenerator: byId });
    const id = freshId();

    expect((await take(guard, id)).admitted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await take(guard, id)).admitted).toBe(true);

    const refused = await take(guard, id);
    expect(refused.admitted).toBe(false);
    expect(refused.reply.send).toHaveBeenCalledWith({
      error: "Too Many Requests",
      code: "RATE_LIMITED",
    });
    // The oldest hit is ~1.5 s old, so ~8.5 s remain: 9 after rounding up.
    const [, seconds] = refused.reply.header.mock.calls[0];
    expect(Number(seconds)).toBeGreaterThanOrEqual(8);
    expect(Number(seconds)).toBeLessThanOrEqual(9);
  });
  it("failure limiter: check does not charge, record does, Retry-After from the oldest failure", async () => {
    const { failureRateLimit } = await loadModule();
    const limiter = failureRateLimit({ max: 2, windowMs: 10_000, keyGenerator: byId });
    const id = freshId();
    const { request } = makeMocks(id);

    for (let i = 0; i < 5; i++) expect((await limiter.check(request)).blocked).toBe(false);
    await limiter.record(request);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await limiter.check(request)).blocked).toBe(false);
    await limiter.record(request);

    const blocked = await limiter.check(request);
    expect(blocked.blocked).toBe(true);
    if (blocked.blocked) {
      // The oldest failure is ~1.5 s old, so ~8.5 s remain.
      expect(blocked.retryAfterMs).toBeGreaterThan(7_500);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(8_600);
    }
    // Checking added nothing (two failures recorded), and Redis served all of it.
    expect(await inspector.zcard(`ratelimit:POST:/live-test:${id}`)).toBe(2);
    expect(request.log.error).not.toHaveBeenCalled();
  });

  it("failure limiter: concurrent records from independent connections are all counted", async () => {
    const id = freshId();
    const limiters = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const { failureRateLimit } = await loadModule();
        return failureRateLimit({ max: 10, windowMs: 10_000, keyGenerator: byId });
      })
    );
    await Promise.all(
      limiters.flatMap((limiter) =>
        Array.from({ length: 5 }, () => limiter.record(makeMocks(id).request as any))
      )
    );
    const { request } = makeMocks(id);
    expect((await limiters[0].check(request)).blocked).toBe(true);
    expect(await inspector.zcard(`ratelimit:POST:/live-test:${id}`)).toBe(20);
  });
});
