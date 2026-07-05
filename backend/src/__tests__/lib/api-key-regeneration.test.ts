import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import { apiKeyRegenerationTokens, clients } from "../../db/schema";
import { createRegenerationToken, validateAndRegenerate } from "../../lib/api-key-regeneration";

let hashCallCount = 0;

vi.mock("../../lib/auth", () => ({
  hashApiKey: vi.fn().mockImplementation(() => {
    hashCallCount++;
    return Promise.resolve(`hashed-api-key-${hashCallCount}-${Date.now()}`);
  }),
  sha256Lookup: vi.fn().mockImplementation((key: string) => {
    hashCallCount++;
    return `sha256-lookup-${hashCallCount}-${Date.now()}-${key.slice(0, 8)}`;
  }),
}));

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const cleanupIds: string[] = [];

beforeAll(async () => {
  vi.clearAllMocks();
});

beforeEach(() => {
  hashCallCount = 0;
});

afterAll(async () => {
  for (const id of cleanupIds) {
    try {
      await db.delete(apiKeyRegenerationTokens).where(eq(apiKeyRegenerationTokens.clientId, id));
      await db.delete(clients).where(eq(clients.id, id));
    } catch {}
  }
});

describe("createRegenerationToken", () => {
  it("creates a token and returns the raw token string", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Unit Test Client",
      email: `unit-${cId}@example.com`,
      status: "active",
    });
    cleanupIds.push(cId);

    const rawToken = await createRegenerationToken({
      clientId: cId,
      email: `unit-${cId}@example.com`,
    });

    expect(rawToken).toBeDefined();
    expect(typeof rawToken).toBe("string");
    expect(rawToken.length).toBe(64);

    const tokens = await db
      .select()
      .from(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.clientId, cId));

    expect(tokens.length).toBe(1);
    expect(tokens[0].status).toBe("pending");
    expect(tokens[0].token).toBe(hashToken(rawToken));
  });

  it("revokes old pending tokens when creating a new one", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Revoke Test Client",
      email: `revoke-${cId}@example.com`,
      status: "active",
    });
    cleanupIds.push(cId);

    const firstToken = await createRegenerationToken({
      clientId: cId,
      email: `revoke-${cId}@example.com`,
    });

    const secondToken = await createRegenerationToken({
      clientId: cId,
      email: `revoke-${cId}@example.com`,
    });

    expect(firstToken).not.toBe(secondToken);

    const tokens = await db
      .select()
      .from(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.clientId, cId));

    const revokedCount = tokens.filter((t: any) => t.status === "revoked").length;
    const pendingCount = tokens.filter((t: any) => t.status === "pending").length;
    expect(revokedCount).toBe(1);
    expect(pendingCount).toBe(1);
  });

  it("does not revoke completed tokens", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Completed Test Client",
      email: `completed-${cId}@example.com`,
      status: "active",
    });
    cleanupIds.push(cId);

    const rawToken = await createRegenerationToken({
      clientId: cId,
      email: `completed-${cId}@example.com`,
    });

    const tokenHash = hashToken(rawToken);
    await db
      .update(apiKeyRegenerationTokens)
      .set({ status: "completed" })
      .where(eq(apiKeyRegenerationTokens.token, tokenHash));

    await createRegenerationToken({
      clientId: cId,
      email: `completed-${cId}@example.com`,
    });

    const tokens = await db
      .select()
      .from(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.clientId, cId));

    const completedCount = tokens.filter((t: any) => t.status === "completed").length;
    const pendingCount = tokens.filter((t: any) => t.status === "pending").length;
    expect(completedCount).toBe(1);
    expect(pendingCount).toBe(1);
  });
});

describe("validateAndRegenerate", () => {
  it("validates token and returns a new API key", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Validate Test Client",
      email: `validate-${cId}@example.com`,
      status: "active",
      apiKeyHash: "hashed:old-key",
      apiKeyLookup: "old-lookup",
    });
    cleanupIds.push(cId);

    const rawToken = await createRegenerationToken({
      clientId: cId,
      email: `validate-${cId}@example.com`,
    });

    const newApiKey = await validateAndRegenerate(rawToken);

    expect(newApiKey).toBeDefined();
    expect(typeof newApiKey).toBe("string");
    expect(newApiKey.length).toBe(64);
  });

  it("updates the client's API key hash and lookup", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Update Test Client",
      email: `update-${cId}@example.com`,
      status: "active",
      apiKeyHash: "hashed:old-key",
      apiKeyLookup: "old-lookup",
    });
    cleanupIds.push(cId);

    const rawToken = await createRegenerationToken({
      clientId: cId,
      email: `update-${cId}@example.com`,
    });

    await validateAndRegenerate(rawToken);

    const [updatedClient] = await db.select().from(clients).where(eq(clients.id, cId)).limit(1);

    expect(updatedClient.apiKeyHash).not.toBe("hashed:old-key");
    expect(updatedClient.apiKeyLookup).not.toBe("old-lookup");
  });

  it("marks the token as completed after use", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Mark Test Client",
      email: `mark-${cId}@example.com`,
      status: "active",
    });
    cleanupIds.push(cId);

    const rawToken = await createRegenerationToken({
      clientId: cId,
      email: `mark-${cId}@example.com`,
    });

    await validateAndRegenerate(rawToken);

    const tokenHash = hashToken(rawToken);
    const [tokenRecord] = await db
      .select()
      .from(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.token, tokenHash))
      .limit(1);

    expect(tokenRecord.status).toBe("completed");
  });

  it("throws 404 for non-existent token", async () => {
    const fakeToken = crypto.randomBytes(32).toString("hex");

    await expect(validateAndRegenerate(fakeToken)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 400 for revoked token", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Revoked Test Client",
      email: `revoked-${cId}@example.com`,
      status: "active",
    });
    cleanupIds.push(cId);

    const rawToken = await createRegenerationToken({
      clientId: cId,
      email: `revoked-${cId}@example.com`,
    });

    const tokenHash = hashToken(rawToken);
    await db
      .update(apiKeyRegenerationTokens)
      .set({ status: "revoked" })
      .where(eq(apiKeyRegenerationTokens.token, tokenHash));

    await expect(validateAndRegenerate(rawToken)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/invalidated/i),
    });
  });

  it("throws 400 for completed token", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Used Test Client",
      email: `used-${cId}@example.com`,
      status: "active",
    });
    cleanupIds.push(cId);

    const rawToken = await createRegenerationToken({
      clientId: cId,
      email: `used-${cId}@example.com`,
    });

    const tokenHash = hashToken(rawToken);
    await db
      .update(apiKeyRegenerationTokens)
      .set({ status: "completed" })
      .where(eq(apiKeyRegenerationTokens.token, tokenHash));

    await expect(validateAndRegenerate(rawToken)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/already been used/i),
    });
  });

  it("throws 400 for expired token", async () => {
    const cId = crypto.randomUUID();
    await db.insert(clients).values({
      id: cId,
      name: "Expired Test Client",
      email: `expired-${cId}@example.com`,
      status: "active",
    });
    cleanupIds.push(cId);

    const rawToken = await createRegenerationToken({
      clientId: cId,
      email: `expired-${cId}@example.com`,
    });

    const tokenHash = hashToken(rawToken);
    await db
      .update(apiKeyRegenerationTokens)
      .set({ createdAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(apiKeyRegenerationTokens.token, tokenHash));

    await expect(validateAndRegenerate(rawToken)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/expired/i),
    });
  });
});
