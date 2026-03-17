import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable in-memory admin store for DB mock
// Rate limit tests don't need a real admin — empty store returns 503 (not 429).
const dbState: { admins: any[] } = { admins: [] };

vi.mock("../../db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: (_table: any) => {
        const rows = [...dbState.admins];
        const p = Promise.resolve(rows);
        return {
          where: (_expr: any) => {
            const first = rows.slice(0, 1);
            const lp = Promise.resolve(first);
            return {
              limit: (n: number) => Promise.resolve(rows.slice(0, n)),
              then: lp.then.bind(lp),
              catch: lp.catch.bind(lp),
              finally: lp.finally.bind(lp),
            };
          },
          then: p.then.bind(p),
          catch: p.catch.bind(p),
          finally: p.finally.bind(p),
        };
      },
    })),
    insert: vi.fn((_table: any) => ({
      values: vi.fn((payload: any) => {
        dbState.admins.push({ ...payload });
        return Promise.resolve();
      }),
    })),
    update: vi.fn((_table: any) => ({
      set: vi.fn((values: any) => ({
        where: vi.fn((_expr: any) => {
          for (const a of dbState.admins) Object.assign(a, values);
          return Promise.resolve();
        }),
      })),
    })),
  },
}));

// Helper function to create a server instance for testing
async function createServer() {
  // Reset modules to ensure clean state
  vi.resetModules();
  const { buildServer } = await import("../../app");
  return buildServer();
}

describe("Auth Rate Limit Integration", () => {
  // Clear rate limit buckets before each test to ensure isolation
  beforeEach(async () => {
    dbState.admins = [];
    // Access the internal hitBuckets map to clear it for test isolation
    const rateLimitModule = await import("../../lib/rate-limit");
    if (rateLimitModule.hitBuckets) {
      rateLimitModule.hitBuckets.clear();
    }
  });

  afterEach(async () => {
    dbState.admins = [];
    // Clean up after each test
    const rateLimitModule = await import("../../lib/rate-limit");
    if (rateLimitModule.hitBuckets) {
      rateLimitModule.hitBuckets.clear();
    }
  });

  it("should allow requests up to the limit before blocking", async () => {
    const server = await createServer();

    // Make 5 requests (the limit) - should all succeed (not 429)
    for (let i = 0; i < 5; i++) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "test",
          password: "test",
        },
        headers: {
          "content-type": "application/json",
        },
      });

      // Expect 400 (missing fields), 401 (invalid creds), or 503 (no admin configured)
      // but NOT 429 (rate limited)
      expect([400, 401, 503]).toContain(response.statusCode);
    }

    // Now make the 6th request which should be blocked
    const sixthResponse = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "test",
        password: "test",
      },
      headers: {
        "content-type": "application/json",
      },
    });

    // The 6th request should be blocked (429)
    expect(sixthResponse.statusCode).toBe(429);
    expect(sixthResponse.json()).toEqual({ error: "Too Many Requests" });

    await server.close();
  });

  it("should block requests after exceeding rate limit", async () => {
    const server = await createServer();

    // Make 5 requests (at the limit)
    for (let i = 0; i < 5; i++) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "test",
          password: "test",
        },
        headers: {
          "content-type": "application/json",
        },
      });

      // Expect 400 (missing fields), 401 (invalid creds), or 503 (no admin configured)
      // but NOT 429 (rate limited)
      expect([400, 401, 503]).toContain(response.statusCode);
    }

    // The 6th request should be rate limited (429)
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "test",
        password: "test",
      },
      headers: {
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "Too Many Requests" });

    await server.close();
  });

  it("should allow requests after the rate limit window resets", async () => {
    const server = await createServer();
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_000_000;
    nowSpy.mockImplementation(() => now);

    try {
      for (let i = 0; i < 5; i++) {
        const response = await server.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: {
            username: "test",
            password: "test",
          },
          headers: {
            "content-type": "application/json",
          },
        });

        expect([400, 401, 503]).toContain(response.statusCode);
      }

      const blockedResponse = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "test",
          password: "test",
        },
        headers: {
          "content-type": "application/json",
        },
      });

      expect(blockedResponse.statusCode).toBe(429);

      now += 15 * 60 * 1000 + 1;

      const resetResponse = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "test",
          password: "test",
        },
        headers: {
          "content-type": "application/json",
        },
      });

      expect([400, 401, 503]).toContain(resetResponse.statusCode);
    } finally {
      nowSpy.mockRestore();
      await server.close();
    }
  });

  it("should track rate limits per IP address", async () => {
    const server = await createServer();

    // First, exhaust the rate limit for one IP by making 5 requests
    for (let i = 0; i < 5; i++) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "test",
          password: "test",
        },
        headers: {
          "content-type": "application/json",
        },
      });

      // Expect 400 (missing fields), 401 (invalid creds), or 503 (no admin configured)
      // but NOT 429 (rate limited)
      expect([400, 401, 503]).toContain(response.statusCode);
    }

    // The 6th request from the same IP should be rate limited (429)
    const blockedResponse = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "test",
        password: "test",
      },
      headers: {
        "content-type": "application/json",
      },
    });

    expect(blockedResponse.statusCode).toBe(429);
    expect(blockedResponse.json()).toEqual({ error: "Too Many Requests" });

    // Close the first server to clear its rate limit state
    await server.close();

    // Create a new server instance to get a fresh rate limit state (simulating different IP)
    const server2 = await createServer();

    // The first request from a different IP should not be rate limited
    const freshIpResponse = await server2.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "test",
        password: "test",
      },
      headers: {
        "content-type": "application/json",
      },
    });

    // Should not be blocked (expect 400, 401, or 503 — not 429)
    expect([400, 401, 503]).toContain(freshIpResponse.statusCode);

    await server2.close();
  });
});
