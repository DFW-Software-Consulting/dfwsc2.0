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

  // The charge is only ever blocked or a slot; narrow it for tests that expect a slot.
  async function chargeOk(limiter: any, request: any, member: string) {
    const result = await limiter.charge(request, member);
    expect(result.blocked).toBe(false);
    return result as { keep: () => void; release: () => Promise<void> };
  }

  it("admits up to max distinct members, then refuses with the full window", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000 });
    const request = makeRequest();

    for (let i = 0; i < 3; i++) (await chargeOk(limiter, request, `m${i}`)).keep();
    expect(await limiter.charge(request as any, "m3")).toEqual({
      blocked: true,
      retryAfterMs: 60_000,
    });
  });

  it("counts a repeated member once, however often it is charged", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 2, windowMs: 60_000 });
    const request = makeRequest();

    for (let i = 0; i < 100; i++) (await chargeOk(limiter, request, "same")).keep();
    // One unit used: a different member still fits, a third does not.
    (await chargeOk(limiter, request, "other")).keep();
    expect((await limiter.charge(request as any, "third")).blocked).toBe(true);
    // And the repeat is still admitted at the max, since it is already counted.
    expect((await limiter.charge(request as any, "same")).blocked).toBe(false);
  });

  it("release takes back a member the request added, so successes are never counted", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
    const request = makeRequest();

    for (let i = 0; i < 10; i++) await (await chargeOk(limiter, request, `ok${i}`)).release();
    (await chargeOk(limiter, request, "bad")).keep();
    expect((await limiter.charge(request as any, "another")).blocked).toBe(true);
  });

  it("a request that did not add the member cannot take it back", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
    const request = makeRequest();

    const first = await chargeOk(limiter, request, "k");
    first.keep();
    const repeat = await chargeOk(limiter, request, "k");
    await repeat.release();
    expect((await limiter.charge(request as any, "other")).blocked).toBe(true);
  });

  it("settling a slot twice is harmless", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
    const request = makeRequest();

    const slot = await chargeOk(limiter, request, "k");
    await slot.release();
    await slot.release();
    slot.keep();
    // The member was released first and stays released.
    (await chargeOk(limiter, request, "other")).keep();
    expect((await limiter.charge(request as any, "third")).blocked).toBe(true);
  });

  it("reports the time until the oldest member leaves the window", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 2, windowMs: 60_000 });
    const request = makeRequest();

    (await chargeOk(limiter, request, "a")).keep();
    vi.setSystemTime(new Date(START.getTime() + 10_000));
    (await chargeOk(limiter, request, "b")).keep();
    vi.setSystemTime(new Date(START.getTime() + 25_000));

    expect(await limiter.charge(request as any, "c")).toEqual({
      blocked: true,
      retryAfterMs: 35_000,
    });
  });

  it("does not refresh a repeated member's time, so it still ages out", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
    const request = makeRequest();

    (await chargeOk(limiter, request, "a")).keep();
    vi.setSystemTime(new Date(START.getTime() + 40_000));
    (await chargeOk(limiter, request, "a")).keep();
    vi.setSystemTime(new Date(START.getTime() + 60_001));
    (await chargeOk(limiter, request, "b")).keep();
  });

  it("unblocks as members age out of the window", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 2, windowMs: 60_000 });
    const request = makeRequest();

    (await chargeOk(limiter, request, "a")).keep();
    (await chargeOk(limiter, request, "b")).keep();
    expect((await limiter.charge(request as any, "c")).blocked).toBe(true);

    vi.setSystemTime(new Date(START.getTime() + 60_001));
    expect((await limiter.charge(request as any, "c")).blocked).toBe(false);
  });

  it("record counts a member even past the max, once", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
    const request = makeRequest();

    (await chargeOk(limiter, request, "a")).keep();
    await limiter.record(request as any, "late");
    await limiter.record(request as any, "late");
    expect((await limiter.charge(request as any, "other")).blocked).toBe(true);
    // The recorded member is counted, so a repeat of it is admitted at the max.
    expect((await limiter.charge(request as any, "late")).blocked).toBe(false);
  });

  it("keeps separate budgets per IP and per name", async () => {
    const { failureRateLimit } = await load();
    const one = failureRateLimit({ max: 1, windowMs: 60_000, name: "one" });
    const two = failureRateLimit({ max: 1, windowMs: 60_000, name: "two" });

    (await chargeOk(one, makeRequest("10.0.0.1"), "a")).keep();
    expect((await one.charge(makeRequest("10.0.0.1") as any, "b")).blocked).toBe(true);
    expect((await one.charge(makeRequest("10.0.0.2") as any, "b")).blocked).toBe(false);
    expect((await two.charge(makeRequest("10.0.0.1") as any, "b")).blocked).toBe(false);
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
    expect((await limiter.charge(request as any, "a")).blocked).toBe(false);
  });

  describe("concurrency", () => {
    // Stands in for the work the charge protects: a lookup that takes a moment to finish.
    async function lookup() {
      await Promise.resolve();
      await Promise.resolve();
    }

    it("200 concurrent distinct failing members: only max reach the work", async () => {
      const { failureRateLimit } = await load();
      const limiter = failureRateLimit({ max: 30, windowMs: 60_000 });
      const request = makeRequest();
      let lookups = 0;

      const outcomes = await Promise.all(
        Array.from({ length: 200 }, async (_, i) => {
          const charge = await limiter.charge(request as any, `junk-${i}`);
          if (charge.blocked) return "refused";
          lookups += 1;
          await lookup();
          charge.keep();
          return "failed";
        })
      );

      expect(lookups).toBe(30);
      expect(outcomes.filter((o) => o === "failed")).toHaveLength(30);
      expect(outcomes.filter((o) => o === "refused")).toHaveLength(170);
    });

    it("200 concurrent charges of the same member: all admitted, one unit used", async () => {
      const { failureRateLimit } = await load();
      const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
      const request = makeRequest();

      const charges = await Promise.all(
        Array.from({ length: 200 }, () => limiter.charge(request as any, "same"))
      );
      expect(charges.every((c) => !c.blocked)).toBe(true);
      for (const c of charges) if (!c.blocked) c.keep();
      expect((await limiter.charge(request as any, "other")).blocked).toBe(true);
    });

    it("never refuses distinct valid members because of other members still in flight", async () => {
      const { failureRateLimit } = await load();
      const limiter = failureRateLimit({ max: 30, windowMs: 60_000 });
      const request = makeRequest();

      const outcomes = await Promise.all(
        Array.from({ length: 200 }, async (_, i) => {
          const charge = await limiter.charge(request as any, `valid-${i}`);
          if (charge.blocked) return "refused";
          await lookup();
          await charge.release();
          return "served";
        })
      );

      expect(outcomes.every((o) => o === "served")).toBe(true);
    });

    it("mixed: junk is capped at max and valid members are served as long as budget remains", async () => {
      const { failureRateLimit } = await load();
      const limiter = failureRateLimit({ max: 30, windowMs: 60_000 });
      const request = makeRequest();
      let junkLookups = 0;

      const outcomes = await Promise.all(
        Array.from({ length: 300 }, async (_, i) => {
          const isValid = i % 10 === 0; // 30 valid, 270 junk, interleaved
          const charge = await limiter.charge(request as any, `${isValid ? "valid" : "junk"}-${i}`);
          if (charge.blocked) return { isValid, served: false };
          if (!isValid) junkLookups += 1;
          await lookup();
          if (isValid) await charge.release();
          else charge.keep();
          return { isValid, served: true };
        })
      );

      expect(junkLookups).toBeLessThanOrEqual(30);
      // The first 30 requests to arrive hold all the units, so the valid members that arrive
      // later are refused only because 30 distinct junk members really did fail first.
      const failedCount = outcomes.filter((o) => !o.isValid && o.served).length;
      expect(failedCount).toBe(junkLookups);
      for (const o of outcomes) if (o.isValid && !o.served) expect(failedCount).toBe(30);
    });

    it("a refused request is told the time left once nothing is in flight", async () => {
      const { failureRateLimit } = await load();
      const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
      const request = makeRequest();

      const [first, second] = await Promise.all([
        limiter.charge(request as any, "a").then(async (c) => {
          await lookup();
          if (!c.blocked) c.keep();
          return c;
        }),
        limiter.charge(request as any, "b"),
      ]);
      expect(first.blocked).toBe(false);
      expect(second).toEqual({ blocked: true, retryAfterMs: 60_000 });
    });
  });
});

describe("failureRateLimit (Redis)", () => {
  let mockRedis: any;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    mockRedis = {
      eval: vi.fn(),
      zrem: vi.fn().mockResolvedValue(1),
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

  it("charges with the Lua script: key, window, max, member, no force", async () => {
    mockRedis.eval.mockResolvedValue([2, 0]);
    const { failureRateLimit, FAILURE_CHARGE_LUA } = await load();
    const limiter = failureRateLimit({
      max: 3,
      windowMs: 60_000,
      name: "failed-auth",
      keyGenerator: () => "ip-1",
    });

    const charge = await limiter.charge(makeRequest() as any, "hash-1");
    expect(charge.blocked).toBe(false);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      FAILURE_CHARGE_LUA,
      1,
      "ratelimit:failed-auth:ip-1",
      "60000",
      "3",
      "hash-1",
      "0"
    );
  });

  it("refuses with the Retry-After the script reports", async () => {
    mockRedis.eval.mockResolvedValue([0, 40_000]);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000 });

    expect(await limiter.charge(makeRequest() as any, "hash-1")).toEqual({
      blocked: true,
      retryAfterMs: 40_000,
    });
  });

  it("record asks the script to add the member past the max", async () => {
    mockRedis.eval.mockResolvedValue([2, 0]);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000, keyGenerator: () => "ip-1" });

    await limiter.record(makeRequest() as any, "hash-1");
    expect(mockRedis.eval.mock.calls[0][6]).toBe("1");
  });

  it("release removes only a member this request added", async () => {
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({
      max: 3,
      windowMs: 60_000,
      name: "failed-auth",
      keyGenerator: () => "ip-1",
    });

    mockRedis.eval.mockResolvedValueOnce([2, 0]);
    const added: any = await limiter.charge(makeRequest() as any, "hash-1");
    await added.release();
    expect(mockRedis.zrem).toHaveBeenCalledWith("ratelimit:failed-auth:ip-1", "hash-1");

    mockRedis.zrem.mockClear();
    mockRedis.eval.mockResolvedValueOnce([1, 0]);
    const repeat: any = await limiter.charge(makeRequest() as any, "hash-2");
    await repeat.release();
    expect(mockRedis.zrem).not.toHaveBeenCalled();
  });

  it("keep leaves the member in Redis", async () => {
    mockRedis.eval.mockResolvedValue([2, 0]);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000 });

    const charge: any = await limiter.charge(makeRequest() as any, "hash-1");
    charge.keep();
    expect(mockRedis.zrem).not.toHaveBeenCalled();
  });

  it("a failed release leaves the member counted and does not throw", async () => {
    mockRedis.eval.mockResolvedValue([2, 0]);
    mockRedis.zrem.mockRejectedValue(new Error("Redis connection lost"));
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 3, windowMs: 60_000 });
    const request = makeRequest();

    const charge: any = await limiter.charge(request as any, "hash-1");
    await expect(charge.release()).resolves.toBeUndefined();
    expect(request.log.error).toHaveBeenCalled();
  });

  it("falls back to in-memory counting when Redis fails, logging the error", async () => {
    mockRedis.eval.mockRejectedValue(new Error("Redis connection lost"));
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 2, windowMs: 60_000 });
    const request = makeRequest();

    for (const member of ["a", "b"]) ((await limiter.charge(request as any, member)) as any).keep();
    expect((await limiter.charge(request as any, "c")).blocked).toBe(true);
    expect(request.log.error).toHaveBeenCalled();
  });

  it("falls back to memory when the script returns nothing usable", async () => {
    mockRedis.eval.mockResolvedValue(null);
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });

    expect((await limiter.charge(makeRequest() as any, "a")).blocked).toBe(false);
  });

  it("releases from memory a member that was charged in memory, even if Redis is back", async () => {
    mockRedis.eval.mockRejectedValueOnce(new Error("down"));
    const { failureRateLimit } = await load();
    const limiter = failureRateLimit({ max: 1, windowMs: 60_000 });
    const request = makeRequest();

    const charge: any = await limiter.charge(request as any, "a");
    await charge.release();
    expect(mockRedis.zrem).not.toHaveBeenCalled();
    mockRedis.eval.mockRejectedValue(new Error("down"));
    expect((await limiter.charge(request as any, "b")).blocked).toBe(false);
  });
});
