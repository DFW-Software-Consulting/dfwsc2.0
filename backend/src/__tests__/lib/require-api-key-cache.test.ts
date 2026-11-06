import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  // A lookup the test settles by hand, so the order of events is exact.
  function controlledLookup() {
    let resolve!: (rows: unknown[]) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<unknown[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const chain = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue(result) }),
      }),
    };
    return { chain, resolve, reject };
  }

  function startCall(key: string) {
    const request = makeRequest(key) as any;
    const reply = makeReply();
    const done = requireApiKey(request, reply as any);
    return { request, reply, done };
  }

  describe("a reactivation racing an in-flight verification", () => {
    it("does not record a no-active-client result that started before forgetBadApiKey", async () => {
      const { forgetBadApiKey, sha256Lookup } = await import("../../lib/auth");
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      const stale = controlledLookup();
      mockSelect.mockReturnValueOnce(stale.chain);

      // The verification reads the row as inactive; the admin reactivates the client and clears
      // the record; only then does the verification finish.
      const racing = startCall(apiKey);
      forgetBadApiKey(sha256Lookup(apiKey));
      stale.resolve([]);
      await racing.done;
      expect(racing.reply.code).toHaveBeenCalledWith(401);

      // Nothing was recorded, so the next request looks the key up and is accepted.
      const { request, reply } = await call(apiKey, [client]);
      expect(reply.code).not.toHaveBeenCalled();
      expect(request.client).toBe(client);
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it("still records a result from a verification that started after the forget", async () => {
      const { forgetBadApiKey, sha256Lookup } = await import("../../lib/auth");
      forgetBadApiKey(sha256Lookup(apiKey));

      await call(apiKey, []);
      const repeat = makeReply();
      await requireApiKey(makeRequest(apiKey) as any, repeat as any);
      expect(repeat.code).toHaveBeenCalledWith(401);
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });
  });

  describe("a verification that never finishes", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails every waiting request like a database error after 10 s, then starts fresh", async () => {
      const { isRecentlyVerifiedApiKey } = await import("../../lib/auth");
      const stalled = controlledLookup();
      mockSelect.mockReturnValueOnce(stalled.chain);

      const first = startCall(apiKey);
      const joined = startCall(apiKey);
      expect(mockSelect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(first.reply.code).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([first.done, joined.done]);
      for (const r of [first, joined]) {
        expect(r.reply.code).toHaveBeenCalledWith(500);
        expect(r.reply.send).toHaveBeenCalledWith({
          error: "Internal server error during API key validation.",
        });
        expect(r.request.log.error).toHaveBeenCalledTimes(1);
      }
      // Not recorded as a bad key, not cached as verified.
      expect(isRecentlyVerifiedApiKey(apiKey)).toBe(false);

      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      const { request, reply } = await call(apiKey, [client]);
      expect(reply.code).not.toHaveBeenCalled();
      expect(request.client).toBe(client);
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it("does not time out a lookup that finishes in time, and leaves no timer behind", async () => {
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      const slow = controlledLookup();
      mockSelect.mockReturnValueOnce(slow.chain);

      const running = startCall(apiKey);
      await vi.advanceTimersByTimeAsync(9_000);
      slow.resolve([client]);
      await running.done;
      expect(running.reply.code).not.toHaveBeenCalled();
      expect(running.request.client).toBe(client);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("lets a late no-active-client result neither record a bad key nor overwrite newer state", async () => {
      const { isRecentlyVerifiedApiKey } = await import("../../lib/auth");
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      const stalled = controlledLookup();
      mockSelect.mockReturnValueOnce(stalled.chain);

      const timedOut = startCall(apiKey);
      await vi.advanceTimersByTimeAsync(10_000);
      await timedOut.done;
      expect(timedOut.reply.code).toHaveBeenCalledWith(500);

      // A fresh verification succeeds and is cached; then the stalled lookup comes back late.
      await call(apiKey, [client]);
      expect(isRecentlyVerifiedApiKey(apiKey)).toBe(true);
      stalled.resolve([]);
      await vi.advanceTimersByTimeAsync(0);

      expect(isRecentlyVerifiedApiKey(apiKey)).toBe(true);
      const { reply } = await call(apiKey, [client]);
      expect(reply.code).not.toHaveBeenCalled();
      expect(mockSelect).toHaveBeenCalledTimes(3);
    });

    it("lets a late verified result neither fill the cache nor run bcrypt", async () => {
      const { isRecentlyVerifiedApiKey } = await import("../../lib/auth");
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      const stalled = controlledLookup();
      mockSelect.mockReturnValueOnce(stalled.chain);

      const timedOut = startCall(apiKey);
      await vi.advanceTimersByTimeAsync(10_000);
      await timedOut.done;

      stalled.resolve([client]);
      await vi.advanceTimersByTimeAsync(0);
      expect(isRecentlyVerifiedApiKey(apiKey)).toBe(false);
      expect(compareSpy).not.toHaveBeenCalled();
    });

    it("lets a late failure settle quietly and leaves the newer verification in the map", async () => {
      const client = { id: "c1", apiKeyHash: hash, status: "active" };
      const stalled = controlledLookup();
      const fresh = controlledLookup();
      mockSelect.mockReturnValueOnce(stalled.chain).mockReturnValueOnce(fresh.chain);

      const timedOut = startCall(apiKey);
      await vi.advanceTimersByTimeAsync(10_000);
      await timedOut.done;

      // A new verification is in flight when the old one finally fails, and a request that
      // arrives after that still joins the new one rather than starting a third lookup.
      const newer = startCall(apiKey);
      stalled.reject(new Error("socket closed"));
      await vi.advanceTimersByTimeAsync(0);
      const joiner = startCall(apiKey);
      expect(mockSelect).toHaveBeenCalledTimes(2);

      fresh.resolve([client]);
      await Promise.all([newer.done, joiner.done]);
      expect(newer.reply.code).not.toHaveBeenCalled();
      expect(joiner.reply.code).not.toHaveBeenCalled();
      expect(joiner.request.client).toBe(client);
    });
  });
});
