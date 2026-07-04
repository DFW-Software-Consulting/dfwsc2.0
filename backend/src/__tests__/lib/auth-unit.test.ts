import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// requireAdminJwt re-validates the token's `sub` against the admins table. The
// mock returns a single active admin so that valid, sub-bearing tokens pass the
// DB revalidation step. Tokens without `sub` skip the DB lookup entirely.
vi.mock("../../db/client", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: "admin-1", active: true }]),
        }),
      }),
    }),
  },
}));

import { db } from "../../db/client";
import { requireAdminJwt, signJwt } from "../../lib/auth";

const TEST_SECRET = "test_jwt_secret_minimum_32_characters_long_random_string";

function makeMockReply() {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

function makeRequest(authHeader?: string) {
  return {
    headers: {
      authorization: authHeader,
    },
  };
}

describe("signJwt", () => {
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  it("throws when JWT_SECRET is not set", () => {
    delete process.env.JWT_SECRET;
    expect(() => signJwt({ role: "admin", sub: "admin-1" })).toThrow(
      "JWT_SECRET is not configured"
    );
  });

  it("returns a signed token when JWT_SECRET is set", () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = signJwt({ role: "admin", sub: "admin-1" });
    const decoded = jwt.verify(token, TEST_SECRET) as jwt.JwtPayload;
    expect(decoded.role).toBe("admin");
  });

  it("includes sub (admin id) in the signed token payload", () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = signJwt({ role: "admin", sub: "admin-42" });
    const decoded = jwt.verify(token, TEST_SECRET) as jwt.JwtPayload;
    expect(decoded.sub).toBe("admin-42");
  });
});

describe("requireAdminJwt", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  it("returns 401 when Authorization header is missing", async () => {
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest() as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Authorization header required" });
  });

  it('returns 401 when header format is not "Bearer <token>"', async () => {
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest("Token abc123") as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      error: "Invalid authorization header format. Expected: Bearer <token>",
    });
  });

  it("returns 401 when header has only one part (no space)", async () => {
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest("BearerNoSpace") as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("returns 403 when token role is not admin", async () => {
    const token = jwt.sign({ role: "viewer" }, TEST_SECRET, { expiresIn: "1h" });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: "Forbidden: Admin role required" });
  });

  it('returns 401 with "Token expired" for an expired token', async () => {
    // Sign a token that expired 10 seconds ago
    const token = jwt.sign({ role: "admin" }, TEST_SECRET, { expiresIn: -10 });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Token expired" });
  });

  it('returns 401 with "Invalid token" for a tampered/invalid token', async () => {
    // Build a valid token then corrupt the signature
    const validToken = jwt.sign({ role: "admin" }, TEST_SECRET, { expiresIn: "1h" });
    const tamperedToken = `${validToken.slice(0, -5)}XXXXX`;
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${tamperedToken}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Invalid token" });
  });

  it('returns 401 with "Authentication failed" when JWT_SECRET is missing inside try', async () => {
    // The guard throws a plain Error (not a JWT error) when JWT_SECRET is missing
    // inside the try block. Delete it after the function reads headers but before
    // it calls jwt.verify. We achieve this by deleting it right before the call.
    delete process.env.JWT_SECRET;

    const token = jwt.sign({ role: "admin" }, TEST_SECRET, { expiresIn: "1h" });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Authentication failed" });
  });

  it("does not call reply.code when the token is valid with admin role", async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = jwt.sign({ role: "admin" }, TEST_SECRET, { expiresIn: "1h" });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("accepts a valid HS256-signed token explicitly pinned to that algorithm", async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = jwt.sign({ role: "admin", sub: "admin-1" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("returns 401 when the admin (by sub) no longer exists in the DB", async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const limit = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) }),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of the query builder
    } as any);

    const token = jwt.sign({ role: "admin", sub: "ghost-admin" }, TEST_SECRET, { expiresIn: "1h" });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Account is not active" });
  });

  it("returns 401 when the admin (by sub) is deactivated", async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const limit = vi.fn().mockResolvedValueOnce([{ id: "admin-1", active: false }]);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) }),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock of the query builder
    } as any);

    const token = jwt.sign({ role: "admin", sub: "admin-1" }, TEST_SECRET, { expiresIn: "1h" });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Account is not active" });
  });

  it("rejects a token signed with an algorithm other than HS256", async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    // "none" algorithm requires an unsigned token; simulate an alg mismatch
    // by signing with HS384 while requireAdminJwt only accepts HS256.
    const token = jwt.sign({ role: "admin" }, TEST_SECRET, {
      algorithm: "HS384",
      expiresIn: "1h",
    });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Invalid token" });
  });
});
