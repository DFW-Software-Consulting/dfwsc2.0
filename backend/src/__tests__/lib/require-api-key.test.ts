import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mockSelect so it is accessible inside the vi.mock factory (hoisting happens before imports)
const mockSelect = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  db: { select: mockSelect },
}));

import { requireApiKey } from "../../lib/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(apiKey?: string | string[]) {
  return { headers: { "x-api-key": apiKey }, log: { error: vi.fn() } };
}

function makeReply() {
  const r = { code: vi.fn(), send: vi.fn() };
  r.code.mockReturnValue(r);
  r.send.mockReturnValue(r);
  return r;
}

/** Chain for the fast-path lookup (where + limit). */
function fastChain(result: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

/** Chain for the legacy-path query (where() is directly awaited, no .limit). */
function legacyChain(result: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(result),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requireApiKey", () => {
  beforeEach(() => {
    // mockReset clears both call history AND the mockReturnValueOnce queue so
    // tests don't accidentally inherit setup from the previous test.
    mockSelect.mockReset();
  });

  // ── Missing / invalid header ─────────────────────────────────────────────

  it("returns 401 when x-api-key header is missing", async () => {
    const reply = makeReply();
    await requireApiKey(makeRequest() as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "API key is required." });
  });

  it("returns 401 when x-api-key is an empty/whitespace string", async () => {
    const reply = makeReply();
    await requireApiKey(makeRequest("   ") as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "API key is required." });
  });

  it("uses the first element when x-api-key header is an array", async () => {
    // No matching client in either path → 401 (verifies the array-unwrapping code path)
    mockSelect.mockReturnValueOnce(fastChain([])).mockReturnValueOnce(legacyChain([]));

    const reply = makeReply();
    await requireApiKey(makeRequest(["first-key", "second-key"]) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  // ── Fast path (clientByLookup found) ─────────────────────────────────────

  it("returns 401 when clientByLookup has a null apiKeyHash", async () => {
    const client = { id: "c1", apiKeyHash: null, apiKeyLookup: "abc", status: "active" };
    mockSelect.mockReturnValueOnce(fastChain([client]));

    const reply = makeReply();
    await requireApiKey(makeRequest("any-key") as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Invalid API key." });
  });

  it("returns 401 when clientByLookup has a hash but bcrypt comparison fails", async () => {
    const hash = await bcrypt.hash("correct-key", 10);
    const client = { id: "c2", apiKeyHash: hash, apiKeyLookup: "xyz", status: "active" };
    mockSelect.mockReturnValueOnce(fastChain([client]));

    const reply = makeReply();
    await requireApiKey(makeRequest("wrong-key") as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Invalid API key." });
  });

  it("attaches the client to request and returns when fast-path lookup succeeds", async () => {
    const apiKey = "valid-key-correct";
    const hash = await bcrypt.hash(apiKey, 10);
    const client = { id: "c3", apiKeyHash: hash, apiKeyLookup: "abc123", status: "active" };
    mockSelect.mockReturnValueOnce(fastChain([client]));

    const request = makeRequest(apiKey) as any;
    const reply = makeReply();
    await requireApiKey(request, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
    expect(request.client).toBe(client);
  });

  // ── Legacy fallback path (no clientByLookup) ─────────────────────────────

  it("returns 401 when the legacy query returns no clients", async () => {
    mockSelect.mockReturnValueOnce(fastChain([])).mockReturnValueOnce(legacyChain([]));

    const reply = makeReply();
    await requireApiKey(makeRequest("any-key") as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Invalid API key." });
  });

  it("attaches legacy client to request when hash matches and client is active", async () => {
    const apiKey = "legacy-correct-key";
    const hash = await bcrypt.hash(apiKey, 10);
    const legacyClient = { id: "lc1", apiKeyHash: hash, apiKeyLookup: null, status: "active" };

    mockSelect.mockReturnValueOnce(fastChain([])).mockReturnValueOnce(legacyChain([legacyClient]));

    const request = makeRequest(apiKey) as any;
    const reply = makeReply();
    await requireApiKey(request, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
    expect(request.client).toBe(legacyClient);
  });

  it("skips legacy clients that have no apiKeyHash", async () => {
    const legacyClient = { id: "lc2", apiKeyHash: null, apiKeyLookup: null, status: "active" };

    mockSelect.mockReturnValueOnce(fastChain([])).mockReturnValueOnce(legacyChain([legacyClient]));

    const reply = makeReply();
    await requireApiKey(makeRequest("any-key") as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("skips inactive legacy clients even when the hash matches", async () => {
    const apiKey = "inactive-legacy-key";
    const hash = await bcrypt.hash(apiKey, 10);
    const inactiveClient = { id: "lc3", apiKeyHash: hash, apiKeyLookup: null, status: "inactive" };

    mockSelect
      .mockReturnValueOnce(fastChain([]))
      .mockReturnValueOnce(legacyChain([inactiveClient]));

    const reply = makeReply();
    await requireApiKey(makeRequest(apiKey) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("returns 500 when the database throws during API key validation", async () => {
    mockSelect.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockRejectedValue(new Error("DB connection error")),
        }),
      }),
    });

    const reply = makeReply();
    await requireApiKey(makeRequest("any-key") as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({
      error: "Internal server error during API key validation.",
    });
  });
});
