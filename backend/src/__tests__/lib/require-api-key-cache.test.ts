import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSelect = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  db: { select: mockSelect },
}));

function lookupChain(result: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function makeReply() {
  const r = { code: vi.fn(), send: vi.fn() };
  r.code.mockReturnValue(r);
  r.send.mockReturnValue(r);
  return r;
}

function makeRequest(apiKey: string) {
  return { headers: { "x-api-key": apiKey }, log: { error: vi.fn() } };
}

describe("requireApiKey - verification cache", () => {
  let requireApiKey: typeof import("../../lib/auth").requireApiKey;
  let compareSpy: ReturnType<typeof vi.spyOn>;
  const apiKey = "cache-test-key";
  let hash: string;

  beforeEach(async () => {
    vi.resetModules();
    mockSelect.mockReset();
    ({ requireApiKey } = await import("../../lib/auth"));
    hash ??= await bcrypt.hash(apiKey, 4);
    compareSpy = vi.spyOn(bcrypt, "compare");
  });

  async function call(key: string, rows: unknown[]) {
    mockSelect.mockReturnValueOnce(lookupChain(rows));
    const request = makeRequest(key) as any;
    const reply = makeReply();
    await requireApiKey(request, reply as any);
    return { request, reply };
  }

  it("runs bcrypt once and serves repeat requests from the cache", async () => {
    const client = { id: "c1", apiKeyHash: hash, status: "active" };
    for (let i = 0; i < 3; i++) {
      const { request, reply } = await call(apiKey, [client]);
      expect(reply.code).not.toHaveBeenCalled();
      expect(request.client).toBe(client);
    }
    expect(compareSpy).toHaveBeenCalledTimes(1);
  });

  it("still queries the row on every request so a deactivated client is rejected", async () => {
    const client = { id: "c1", apiKeyHash: hash, status: "active" };
    await call(apiKey, [client]);

    // The query filters on status = active, so a deactivated client returns no row.
    const { reply } = await call(apiKey, []);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("does not accept a cached verification once the stored hash changes", async () => {
    await call(apiKey, [{ id: "c1", apiKeyHash: hash, status: "active" }]);

    const otherHash = await bcrypt.hash("a-regenerated-key", 4);
    const { reply } = await call(apiKey, [{ id: "c1", apiKeyHash: otherHash, status: "active" }]);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(compareSpy).toHaveBeenCalledTimes(2);
  });

  it("re-verifies with bcrypt after the cache entry expires", async () => {
    vi.useFakeTimers();
    try {
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      await call(apiKey, [client]);
      vi.advanceTimersByTime(61_000);
      const { reply } = await call(apiKey, [client]);
      expect(reply.code).not.toHaveBeenCalled();
      expect(compareSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not extend the expiry when a cached entry is used", async () => {
    vi.useFakeTimers();
    try {
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      await call(apiKey, [client]);
      vi.advanceTimersByTime(40_000);
      await call(apiKey, [client]);
      vi.advanceTimersByTime(30_000);
      await call(apiKey, [client]);
      expect(compareSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never caches a failed verification", async () => {
    const client = { id: "c1", apiKeyHash: hash, status: "active" };
    const first = await call("wrong-key", [client]);
    const second = await call("wrong-key", [client]);
    expect(first.reply.code).toHaveBeenCalledWith(401);
    expect(second.reply.code).toHaveBeenCalledWith(401);
    expect(compareSpy).toHaveBeenCalledTimes(2);
  });

  describe("isRecentlyVerifiedApiKey", () => {
    it("is false for a key that was never verified, without touching the database", async () => {
      const { isRecentlyVerifiedApiKey } = await import("../../lib/auth");
      expect(isRecentlyVerifiedApiKey(apiKey)).toBe(false);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("is true after a successful verification and false after a failed one", async () => {
      const { isRecentlyVerifiedApiKey } = await import("../../lib/auth");
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      await call("wrong-key", [client]);
      expect(isRecentlyVerifiedApiKey("wrong-key")).toBe(false);

      await call(apiKey, [client]);
      expect(isRecentlyVerifiedApiKey(apiKey)).toBe(true);
      expect(isRecentlyVerifiedApiKey("another-key")).toBe(false);
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it("is false once the cache entry expires", async () => {
      vi.useFakeTimers();
      try {
        const { isRecentlyVerifiedApiKey } = await import("../../lib/auth");
        await call(apiKey, [{ id: "c1", apiKeyHash: hash, status: "active" }]);
        expect(isRecentlyVerifiedApiKey(apiKey)).toBe(true);
        vi.advanceTimersByTime(61_000);
        expect(isRecentlyVerifiedApiKey(apiKey)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("known-bad key record", () => {
    it("answers a repeat of a key with no active client 401 without a second lookup", async () => {
      const first = await call("no-such-key", []);
      expect(first.reply.code).toHaveBeenCalledWith(401);

      const request = makeRequest("no-such-key") as any;
      const reply = makeReply();
      await requireApiKey(request, reply as any);
      expect(reply.code).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith({ error: "Invalid API key." });
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it("keeps a different key's lookups separate", async () => {
      await call("no-such-key", []);
      await call("another-no-such-key", []);
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it("looks the key up again once the record expires, and accepts it if the client is back", async () => {
      vi.useFakeTimers();
      try {
        const client = { id: "c1", apiKeyHash: hash, status: "active" };
        await call(apiKey, []); // deactivated: no active client
        vi.advanceTimersByTime(30_000);
        const stillBadReply = makeReply();
        await requireApiKey(makeRequest(apiKey) as any, stillBadReply as any);
        expect(stillBadReply.code).toHaveBeenCalledWith(401);
        expect(mockSelect).toHaveBeenCalledTimes(1);

        // The record lasts at most 60 s, so a reactivated client works again by then.
        vi.advanceTimersByTime(30_001);
        const { request, reply } = await call(apiKey, [client]);
        expect(reply.code).not.toHaveBeenCalled();
        expect(request.client).toBe(client);
        expect(mockSelect).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("forgetBadApiKey clears the record at once, as when an admin reactivates a client", async () => {
      const { forgetBadApiKey, sha256Lookup } = await import("../../lib/auth");
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      await call(apiKey, []);
      forgetBadApiKey(sha256Lookup(apiKey));

      const { request, reply } = await call(apiKey, [client]);
      expect(reply.code).not.toHaveBeenCalled();
      expect(request.client).toBe(client);
    });

    it("never records a database error, so the next request is looked up", async () => {
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error("connection reset")),
          }),
        }),
      });
      const failing = makeRequest(apiKey) as any;
      const failingReply = makeReply();
      await requireApiKey(failing, failingReply as any);
      expect(failingReply.code).toHaveBeenCalledWith(500);

      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      const { reply } = await call(apiKey, [client]);
      expect(reply.code).not.toHaveBeenCalled();
    });

    it("stops counting a key as recently verified once its client has no active row", async () => {
      const { isRecentlyVerifiedApiKey } = await import("../../lib/auth");
      await call(apiKey, [{ id: "c1", apiKeyHash: hash, status: "active" }]);
      expect(isRecentlyVerifiedApiKey(apiKey)).toBe(true);

      const { reply } = await call(apiKey, []); // deactivated since
      expect(reply.code).toHaveBeenCalledWith(401);
      expect(isRecentlyVerifiedApiKey(apiKey)).toBe(false);
    });

    it("does not change how a valid key is served, however many bad keys came before", async () => {
      for (let i = 0; i < 50; i++) await call(`junk-${i}`, []);
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      for (let i = 0; i < 3; i++) {
        const { request, reply } = await call(apiKey, [client]);
        expect(reply.code).not.toHaveBeenCalled();
        expect(request.client).toBe(client);
      }
    });

    it("is capped in size, evicting the oldest records", async () => {
      for (let i = 0; i < 1001; i++) await call(`bulk-${i}`, []);
      expect(mockSelect).toHaveBeenCalledTimes(1001);
      // The oldest record was evicted, so it is looked up again; the newest is still known.
      await call("bulk-0", []);
      expect(mockSelect).toHaveBeenCalledTimes(1002);
      const reply = makeReply();
      await requireApiKey(makeRequest("bulk-1000") as any, reply as any);
      expect(reply.code).toHaveBeenCalledWith(401);
      expect(mockSelect).toHaveBeenCalledTimes(1002);
    });
  });

  describe("coalescing concurrent verifications", () => {
    // A lookup that takes a moment, so concurrent requests overlap.
    function slowLookup(rows: unknown[]) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return rows;
            }),
          }),
        }),
      };
    }

    async function callMany(n: number, key: string) {
      return Promise.all(
        Array.from({ length: n }, async () => {
          const request = makeRequest(key) as any;
          const reply = makeReply();
          await requireApiKey(request, reply as any);
          return { request, reply };
        })
      );
    }

    it("20 concurrent requests with the same uncached valid key all succeed on one lookup and one bcrypt", async () => {
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      mockSelect.mockImplementation(() => slowLookup([client]));

      const results = await callMany(20, apiKey);
      expect(results.every((r) => !r.reply.code.mock.calls.length)).toBe(true);
      expect(results.every((r) => r.request.client === client)).toBe(true);
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(compareSpy).toHaveBeenCalledTimes(1);
    });

    it("200 concurrent requests with the same junk key do one lookup, all 401", async () => {
      mockSelect.mockImplementation(() => slowLookup([]));

      const results = await callMany(200, "same-junk");
      expect(results.every((r) => r.reply.code.mock.calls[0][0] === 401)).toBe(true);
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it("does not merge different keys", async () => {
      mockSelect.mockImplementation(() => slowLookup([]));
      await Promise.all([callMany(3, "junk-a"), callMany(3, "junk-b")]);
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it("shares a database error with every request that joined, then recovers", async () => {
      mockSelect.mockImplementationOnce(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              throw new Error("connection reset");
            }),
          }),
        }),
      }));

      const results = await callMany(5, apiKey);
      expect(results.every((r) => r.reply.code.mock.calls[0][0] === 500)).toBe(true);
      expect(mockSelect).toHaveBeenCalledTimes(1);

      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      const next = await call(apiKey, [client]);
      expect(next.reply.code).not.toHaveBeenCalled();
    });

    it("starts a fresh lookup once the shared one has finished", async () => {
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      mockSelect.mockImplementation(() => slowLookup([client]));
      await callMany(5, apiKey);
      await callMany(5, apiKey);
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });
  });
});
