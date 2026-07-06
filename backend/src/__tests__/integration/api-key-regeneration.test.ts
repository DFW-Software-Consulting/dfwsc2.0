import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
  },
}));

vi.mock("../../lib/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  clearTransporterCache: vi.fn(),
}));

vi.mock("../../lib/rate-limit", () => ({
  adminRateLimit: () => async () => {},
  rateLimit: () => async () => {},
  warnIfInMemoryRateLimit: vi.fn(),
}));

import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { apiKeyRegenerationTokens, clients } from "../../db/schema";
import { sendMail } from "../../lib/mailer";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

describe("API Key Regeneration Routes", () => {
  let app: any;

  let clientId: string;
  const clientEmail = `regen-test@example.com`;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    ensureBaseEnv();
    process.env.API_BASE_URL = "http://localhost:4242";

    clientId = crypto.randomUUID();
    await db.insert(clients).values({
      id: clientId,
      name: "Regen Test Client",
      email: clientEmail,
      status: "active",
      apiKeyHash: "hashed:original-api-key",
      apiKeyLookup: crypto.createHash("sha256").update("original-api-key").digest("hex"),
    });
    cleanupIds.push(clientId);

    app = await buildServer();
  });

  afterAll(async () => {
    for (const id of cleanupIds) {
      await db
        .delete(apiKeyRegenerationTokens)
        .where(eq(apiKeyRegenerationTokens.clientId, id))
        .catch(() => undefined);
      await db
        .delete(clients)
        .where(eq(clients.id, id))
        .catch(() => undefined);
    }
    if (app) await app.close();
  });

  beforeEach(async () => {
    await db
      .delete(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.clientId, clientId))
      .catch(() => undefined);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/v1/api-key/regenerate-request", () => {
    it("returns 200 with success message for a valid email", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request",
        headers: { "content-type": "application/json" },
        payload: { email: clientEmail },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().message).toMatch(/regeneration link/i);
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: clientEmail,
          subject: expect.stringContaining("Regenerate API Key"),
        })
      );
    });

    it("returns 200 with same success message for non-existent email", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request",
        headers: { "content-type": "application/json" },
        payload: { email: "nobody@nowhere.example.com" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().message).toMatch(/regeneration link/i);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid email format", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request",
        headers: { "content-type": "application/json" },
        payload: { email: "not-an-email" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("creates a regeneration token in the database", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request",
        headers: { "content-type": "application/json" },
        payload: { email: clientEmail },
      });

      const tokens = await db
        .select()
        .from(apiKeyRegenerationTokens)
        .where(eq(apiKeyRegenerationTokens.clientId, clientId));

      expect(tokens.length).toBeGreaterThanOrEqual(1);
      const pendingToken = tokens.find((t: any) => t.status === "pending");
      expect(pendingToken).toBeDefined();
      expect(pendingToken.email).toBe(clientEmail);
    });
  });

  describe("POST /api/v1/api-key/regenerate-request/admin", () => {
    it("returns 200 and sends email for a valid clientId", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request/admin",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().clientId).toBe(clientId);
      expect(response.json().message).toMatch(/sent successfully/i);
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: clientEmail,
          subject: expect.stringContaining("Regenerate API Key"),
        })
      );
    });

    it("returns 502 when the regeneration email cannot be sent", async () => {
      const token = makeAdminToken();
      (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request/admin",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId },
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        error: "Failed to send regeneration email. Please try again.",
        code: "EMAIL_DELIVERY_FAILED",
      });
      expect(sendMail).toHaveBeenCalledTimes(1);

      const pendingTokens = await db
        .select()
        .from(apiKeyRegenerationTokens)
        .where(
          and(
            eq(apiKeyRegenerationTokens.clientId, clientId),
            eq(apiKeyRegenerationTokens.status, "pending")
          )
        );
      expect(pendingTokens).toHaveLength(0);

      const revokedTokens = await db
        .select()
        .from(apiKeyRegenerationTokens)
        .where(
          and(
            eq(apiKeyRegenerationTokens.clientId, clientId),
            eq(apiKeyRegenerationTokens.status, "revoked")
          )
        );
      expect(revokedTokens).toHaveLength(1);
    });

    it("returns 404 for non-existent clientId", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request/admin",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId: crypto.randomUUID() },
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 401 without admin JWT", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request/admin",
        headers: { "content-type": "application/json" },
        payload: { clientId },
      });

      expect(response.statusCode).toBe(401);
    });

    it("revokes previous pending tokens when creating a new one", async () => {
      const token = makeAdminToken();

      await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request/admin",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId },
      });

      await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request/admin",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId },
      });

      const tokens = await db
        .select()
        .from(apiKeyRegenerationTokens)
        .where(eq(apiKeyRegenerationTokens.clientId, clientId));

      const revokedCount = tokens.filter((t: any) => t.status === "revoked").length;
      const pendingCount = tokens.filter((t: any) => t.status === "pending").length;
      expect(revokedCount).toBeGreaterThanOrEqual(1);
      expect(pendingCount).toBe(1);
    });
  });

  describe("POST /api/v1/api-key/regenerate", () => {
    async function seedRegenToken(
      status: "pending" | "completed" | "revoked",
      opts?: { expired?: boolean }
    ): Promise<string> {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(rawToken);

      await db.insert(apiKeyRegenerationTokens).values({
        id: crypto.randomUUID(),
        clientId,
        token: tokenHash,
        status,
        email: clientEmail,
        ...(opts?.expired ? { createdAt: new Date(Date.now() - 20 * 60 * 1000) } : {}),
      });

      return rawToken;
    }

    const redeemToken = (token?: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate",
        headers: { "content-type": "application/json" },
        ...(token ? { payload: { token } } : {}),
      });

    it("returns 200 with new apiKey for a valid token", async () => {
      const rawToken = await seedRegenToken("pending");

      const response = await redeemToken(rawToken);

      expect(response.statusCode).toBe(200);
      expect(response.json().apiKey).toBeDefined();
      expect(typeof response.json().apiKey).toBe("string");
    });

    it("returns 400 for missing token", async () => {
      const response = await redeemToken();

      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for invalid token", async () => {
      const fakeToken = crypto.randomBytes(32).toString("hex");

      const response = await redeemToken(fakeToken);

      expect(response.statusCode).toBe(404);
    });

    it("returns 400 for expired token", async () => {
      const rawToken = await seedRegenToken("pending", { expired: true });

      const response = await redeemToken(rawToken);

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/expired/i);
    });

    it("returns 400 for already-used token (completed)", async () => {
      const rawToken = await seedRegenToken("completed");

      const response = await redeemToken(rawToken);

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/already been used/i);
    });

    it("returns 400 for revoked token", async () => {
      const rawToken = await seedRegenToken("revoked");

      const response = await redeemToken(rawToken);

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/invalidated/i);
    });

    it("updates the client's API key in the database", async () => {
      const rawToken = await seedRegenToken("pending");

      const clientBefore = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      const oldHash = clientBefore[0].apiKeyHash;

      const response = await redeemToken(rawToken);

      expect(response.statusCode).toBe(200);

      const clientAfter = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);

      expect(clientAfter[0].apiKeyHash).not.toBe(oldHash);
    });

    it("marks the token as completed after use", async () => {
      const rawToken = await seedRegenToken("pending");

      await redeemToken(rawToken);

      const tokenHash = hashToken(rawToken);
      const tokens = await db
        .select()
        .from(apiKeyRegenerationTokens)
        .where(eq(apiKeyRegenerationTokens.token, tokenHash))
        .limit(1);

      expect(tokens[0].status).toBe("completed");
    });

    it("cannot be used twice", async () => {
      const rawToken = await seedRegenToken("pending");

      const first = await redeemToken(rawToken);
      expect(first.statusCode).toBe(200);

      const second = await redeemToken(rawToken);
      expect(second.statusCode).toBe(400);
    });
  });
});
