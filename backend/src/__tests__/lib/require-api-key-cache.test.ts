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
});
