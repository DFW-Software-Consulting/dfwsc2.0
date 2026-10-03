import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

function makeMocks(route = "/auth/login", method = "POST", ip = "127.0.0.1") {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const request = {
    ip,
    method,
    headers: {},
    routeOptions: { url: route },
    log: { error: vi.fn() },
  };
  return { request, reply };
}

type Guard = (request: any, reply: any) => Promise<unknown>;

// Replays the bypass from the review: hits on a short-window limiter used to
// prune the long-window login history that shared the same per-IP entry.
async function exerciseTwoLimiters(rateLimit: (o: any) => Guard) {
  const login = rateLimit({ max: 5, windowMs: 15 * 60_000 });
  const session = rateLimit({ max: 30, windowMs: 60_000 });

  const loginAttempt = async () => {
    const { request, reply } = makeMocks("/auth/login", "POST");
    await login(request, reply);
    // Distinct timestamps per attempt, as with real traffic: the Redis path
    // trims rejected hits by score, so same-millisecond hits would be trimmed too.
    vi.advanceTimersByTime(1);
    return reply.code.mock.calls.length > 0 ? reply.code.mock.calls[0][0] : 200;
  };

  for (let i = 0; i < 5; i++) expect(await loginAttempt()).toBe(200);
  expect(await loginAttempt()).toBe(429);

  vi.advanceTimersByTime(61_000);
  const s = makeMocks("/payments/session", "GET");
  await session(s.request, s.reply);
  expect(s.reply.code).not.toHaveBeenCalled();

  // The session hit must not have erased the login history.
  expect(await loginAttempt()).toBe(429);

  // And the login history must not count against the session route.
  for (let i = 0; i < 29; i++) {
    const m = makeMocks("/payments/session", "GET");
    await session(m.request, m.reply);
    expect(m.reply.code).not.toHaveBeenCalled();
  }
}

describe("rateLimit bucket isolation - in-memory", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  it("keeps limiters on different routes in separate buckets for one IP", async () => {
    const { rateLimit } = await import("../../lib/rate-limit");
    await exerciseTwoLimiters(rateLimit);
  });

  it("uses an explicit name instead of the route when given", async () => {
    const { rateLimit } = await import("../../lib/rate-limit");
    const a = rateLimit({ max: 1, windowMs: 60_000, name: "shared" });
    const b = rateLimit({ max: 1, windowMs: 60_000, name: "shared" });
    const one = makeMocks("/a", "GET");
    const two = makeMocks("/b", "GET");
    await a(one.request as any, one.reply as any);
    await b(two.request as any, two.reply as any);
    expect(one.reply.code).not.toHaveBeenCalled();
    expect(two.reply.code).toHaveBeenCalledWith(429);
  });

  it("separates the same pattern across HTTP methods", async () => {
    const { rateLimit } = await import("../../lib/rate-limit");
    const guard = rateLimit({ max: 1, windowMs: 60_000 });
    const get = makeMocks("/x", "GET");
    const post = makeMocks("/x", "POST");
    await guard(get.request as any, get.reply as any);
    await guard(post.request as any, post.reply as any);
    expect(post.reply.code).not.toHaveBeenCalled();
  });
});

describe("rateLimit bucket isolation - Redis path", () => {
  const store = new Map<string, Array<{ score: number; member: string }>>();

  function prune(key: string, min: number, max: number) {
    const set = store.get(key) ?? [];
    store.set(
      key,
      set.filter((e) => e.score < min || e.score > max)
    );
  }

  // Minimal sorted-set emulation: enough of ZREMRANGEBYSCORE/ZCARD/ZADD to
  // exercise the sliding window against real keys.
  function fakeRedis() {
    return {
      on: vi.fn(),
      zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
        prune(key, min, max);
      }),
      pipeline: vi.fn(() => {
        const ops: Array<() => unknown> = [];
        const p: any = {
          zremrangebyscore: (key: string, min: number, max: number) => {
            ops.push(() => {
              prune(key, min, max);
              return "ok";
            });
            return p;
          },
          zcard: (key: string) => {
            ops.push(() => (store.get(key) ?? []).length);
            return p;
          },
          zadd: (key: string, score: string, member: string) => {
            ops.push(() => {
              const set = store.get(key) ?? [];
              set.push({ score: Number(score), member });
              store.set(key, set);
              return 1;
            });
            return p;
          },
          pexpire: () => {
            ops.push(() => 1);
            return p;
          },
          exec: async () => ops.map((op) => [null, op()]),
        };
        return p;
      }),
    };
  }

  beforeEach(() => {
    vi.resetModules();
    store.clear();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.doMock("ioredis", () => ({
      // biome-ignore lint/complexity/useArrowFunction: vitest requires a constructable (non-arrow) implementation for mocks called with `new`
      default: vi.fn().mockImplementation(function () {
        return fakeRedis();
      }),
    }));
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  it("keeps limiters on different routes in separate buckets for one IP", async () => {
    try {
      const { rateLimit } = await import("../../lib/rate-limit");
      await exerciseTwoLimiters(rateLimit);
      const keys = [...store.keys()];
      expect(keys).toContain("ratelimit:POST:/auth/login:127.0.0.1");
      expect(keys).toContain("ratelimit:GET:/payments/session:127.0.0.1");
    } finally {
      delete process.env.REDIS_URL;
    }
  });
});
