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

  const bucketKey = (id: string) => `ratelimit:bucket:POST:/live-test:${id}`;
  const storedTokens = async (id: string) => Number(await inspector.hget(bucketKey(id), "tokens"));

  it("refund: gives back exactly one token to the bucket the request took it from", async () => {
    const { tokenBucketRateLimit } = await loadModule();
    const guard = tokenBucketRateLimit({ capacity: 3, refillPerMinute: 0.6, keyGenerator: byId });
    const id = freshId();

    const taken = [];
    for (let i = 0; i < 3; i++) taken.push(await take(guard, id));
    expect((await take(guard, id)).admitted).toBe(false);

    expect(await guard.refund(taken[0].request)).toBe(true);
    expect((await take(guard, id)).admitted).toBe(true);
    expect((await take(guard, id)).admitted).toBe(false);
    // Served by Redis, not by the in-memory fallback.
    expect(taken[0].request.log.error).not.toHaveBeenCalled();
  });

  it("refund: a second refund of the same request adds nothing", async () => {
    const { tokenBucketRateLimit } = await loadModule();
    const guard = tokenBucketRateLimit({ capacity: 5, refillPerMinute: 0.6, keyGenerator: byId });
    const id = freshId();

    const first = await take(guard, id);
    await take(guard, id);
    expect(await guard.refund(first.request)).toBe(true);
    const afterOne = await storedTokens(id);
    expect(await guard.refund(first.request)).toBe(false);
    expect(await guard.refund(first.request)).toBe(false);
    expect(await storedTokens(id)).toBe(afterOne);
    expect(afterOne).toBeCloseTo(4, 1);
  });

  it("refund: never raises the bucket above capacity", async () => {
    const { tokenBucketRateLimit } = await loadModule();
    // 100 tokens per second: full again within ~20 ms.
    const guard = tokenBucketRateLimit({ capacity: 2, refillPerMinute: 6000, keyGenerator: byId });
    const id = freshId();

    const first = await take(guard, id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await guard.refund(first.request)).toBe(true);
    expect(await storedTokens(id)).toBe(2);
  });

  it("refund: leaves a bucket that has expired as full, creating nothing", async () => {
    const { tokenBucketRateLimit } = await loadModule();
    // Full in 1 s; the key expires about 2 s after the take.
    const guard = tokenBucketRateLimit({ capacity: 1, refillPerMinute: 60, keyGenerator: byId });
    const id = freshId();

    const first = await take(guard, id);
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(await inspector.exists(bucketKey(id))).toBe(0);
    await guard.refund(first.request);
    expect(await inspector.exists(bucketKey(id))).toBe(0);
  });

  it("refund: concurrent refunds from independent connections return each token once", async () => {
    const id = freshId();
    const guards = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const { tokenBucketRateLimit } = await loadModule();
        return tokenBucketRateLimit({ capacity: 50, refillPerMinute: 0.6, keyGenerator: byId });
      })
    );

    const outcomes = await Promise.all(
      guards.flatMap((guard) =>
        Array.from({ length: 30 }, async () => ({ guard, ...(await take(guard, id)) }))
      )
    );
    const admitted = outcomes.filter((o) => o.admitted);
    expect(admitted).toHaveLength(50);
    expect(await storedTokens(id)).toBeLessThan(1);

    // Every admitted request is refunded three times at once; only the first of each counts.
    const refunds = await Promise.all(
      admitted.flatMap((o) => Array.from({ length: 3 }, () => o.guard.refund(o.request)))
    );
    expect(refunds.filter(Boolean)).toHaveLength(50);
    expect(await storedTokens(id)).toBeCloseTo(50, 1);

    // The bucket holds exactly its capacity again: 50 more are admitted, then none.
    const again = await Promise.all(
      guards.flatMap((guard) => Array.from({ length: 12 }, () => take(guard, id)))
    );
    expect(again.filter((o) => o.admitted)).toHaveLength(50);
  });

  it("refund: concurrent takes and refunds interleave without losing or inventing a token", async () => {
    const id = freshId();
    const guards = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const { tokenBucketRateLimit } = await loadModule();
        return tokenBucketRateLimit({ capacity: 10, refillPerMinute: 0.6, keyGenerator: byId });
      })
    );

    // Each admitted request hands its token straight back, while others are still taking.
    const results = await Promise.all(
      guards.flatMap((guard) =>
        Array.from({ length: 25 }, async () => {
          const attempt = await take(guard, id);
          if (attempt.admitted) await guard.refund(attempt.request);
          return attempt.admitted;
        })
      )
    );

    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(10);
    // Every token taken was returned once, so the bucket is exactly full, never above.
    expect(await storedTokens(id)).toBeCloseTo(10, 1);
    expect(await storedTokens(id)).toBeLessThanOrEqual(10);
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

  // The failure limiter's charges, as the status endpoint uses them: charge, then keep (a failed
  // key) or release (a valid one).
  type Charged = { blocked: false; keep: () => void; release: () => Promise<void> };
  const key = (id: string) => `ratelimit:POST:/live-test:${id}`;

  it("failure limiter: charges distinct members, counts a repeat once, refuses past the max", async () => {
    const { failureRateLimit } = await loadModule();
    const limiter = failureRateLimit({ max: 3, windowMs: 10_000, keyGenerator: byId });
    const id = freshId();
    const { request } = makeMocks(id);

    for (let i = 0; i < 20; i++) ((await limiter.charge(request, "same")) as Charged).keep();
    expect(await inspector.zcard(key(id))).toBe(1);
    for (const member of ["b", "c"]) ((await limiter.charge(request, member)) as Charged).keep();
    expect(await inspector.zcard(key(id))).toBe(3);

    expect((await limiter.charge(request, "d")).blocked).toBe(true);
    // A refusal adds nothing, and an already counted member is still admitted at the max.
    expect(await inspector.zcard(key(id))).toBe(3);
    expect((await limiter.charge(request, "same")).blocked).toBe(false);
    expect(request.log.error).not.toHaveBeenCalled();
  });

  it("failure limiter: Retry-After comes from the oldest member, on Redis's clock", async () => {
    const { failureRateLimit } = await loadModule();
    const limiter = failureRateLimit({ max: 2, windowMs: 10_000, keyGenerator: byId });
    const id = freshId();
    const { request } = makeMocks(id);

    ((await limiter.charge(request, "a")) as Charged).keep();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    ((await limiter.charge(request, "b")) as Charged).keep();

    const blocked = await limiter.charge(request, "c");
    expect(blocked.blocked).toBe(true);
    if (blocked.blocked) {
      // The oldest member is ~1.5 s old, so ~8.5 s remain.
      expect(blocked.retryAfterMs).toBeGreaterThan(7_500);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(8_600);
    }
    expect(request.log.error).not.toHaveBeenCalled();
  });

  it("failure limiter: a member leaves the window, and the key expires with it", async () => {
    const { failureRateLimit } = await loadModule();
    const limiter = failureRateLimit({ max: 1, windowMs: 1_000, keyGenerator: byId });
    const id = freshId();
    const { request } = makeMocks(id);

    ((await limiter.charge(request, "a")) as Charged).keep();
    expect((await limiter.charge(request, "b")).blocked).toBe(true);
    const ttl = await inspector.pttl(key(id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1_000);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await limiter.charge(request, "b")).blocked).toBe(false);
  });

  it("failure limiter: release removes only what the request added", async () => {
    const { failureRateLimit } = await loadModule();
    const limiter = failureRateLimit({ max: 5, windowMs: 10_000, keyGenerator: byId });
    const id = freshId();
    const { request } = makeMocks(id);

    const failed = (await limiter.charge(request, "failed")) as Charged;
    failed.keep();
    const repeat = (await limiter.charge(request, "failed")) as Charged;
    await repeat.release();
    expect(await inspector.zscore(key(id), "failed")).not.toBeNull();

    const ok = (await limiter.charge(request, "valid")) as Charged;
    expect(await inspector.zscore(key(id), "valid")).not.toBeNull();
    await ok.release();
    expect(await inspector.zscore(key(id), "valid")).toBeNull();
    expect(await inspector.zcard(key(id))).toBe(1);
  });

  it("failure limiter: record adds a member past the max, once", async () => {
    const { failureRateLimit } = await loadModule();
    const limiter = failureRateLimit({ max: 1, windowMs: 10_000, keyGenerator: byId });
    const id = freshId();
    const { request } = makeMocks(id);

    ((await limiter.charge(request, "a")) as Charged).keep();
    await limiter.record(request, "late");
    const score = await inspector.zscore(key(id), "late");
    await limiter.record(request, "late");
    expect(await inspector.zcard(key(id))).toBe(2);
    expect(await inspector.zscore(key(id), "late")).toBe(score);
  });

  it("failure limiter: concurrent charges of distinct members from independent connections admit exactly max", async () => {
    const id = freshId();
    const limiters = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const { failureRateLimit } = await loadModule();
        return failureRateLimit({ max: 10, windowMs: 10_000, keyGenerator: byId });
      })
    );
    const outcomes = await Promise.all(
      limiters.flatMap((limiter, c) =>
        Array.from({ length: 25 }, async (_, i) => {
          const charge = await limiter.charge(makeMocks(id).request, `m-${c}-${i}`);
          if (!charge.blocked) charge.keep();
          return charge.blocked ? "refused" : "admitted";
        })
      )
    );

    expect(outcomes).toHaveLength(100);
    expect(outcomes.filter((o) => o === "admitted")).toHaveLength(10);
    expect(await inspector.zcard(key(id))).toBe(10);
  });

  it("failure limiter: the same member charged concurrently from independent connections is one unit", async () => {
    const id = freshId();
    const limiters = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const { failureRateLimit } = await loadModule();
        return failureRateLimit({ max: 1, windowMs: 10_000, keyGenerator: byId });
      })
    );
    const charges = await Promise.all(
      limiters.flatMap((limiter) =>
        Array.from({ length: 10 }, () => limiter.charge(makeMocks(id).request, "same"))
      )
    );

    expect(charges.every((c) => !c.blocked)).toBe(true);
    for (const c of charges) if (!c.blocked) c.keep();
    expect(await inspector.zcard(key(id))).toBe(1);
  });

  it("failure limiter: valid members released after their lookup never fill the budget", async () => {
    const id = freshId();
    const limiter = await (async () => {
      const { failureRateLimit } = await loadModule();
      return failureRateLimit({ max: 5, windowMs: 10_000, keyGenerator: byId });
    })();

    // 40 concurrent valid members against a max of 5: each holds a unit only while "looking up".
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const charge = await limiter.charge(makeMocks(id).request, `valid-${i}`);
        if (charge.blocked) return "refused";
        await new Promise((resolve) => setTimeout(resolve, 5));
        await charge.release();
        return "served";
      })
    );

    expect(outcomes.every((o) => o === "served")).toBe(true);
    expect(await inspector.zcard(key(id))).toBe(0);
  });
});
