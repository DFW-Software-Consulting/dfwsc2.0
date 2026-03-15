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

// Bypass in-memory rate limiter so tests don't hit the 5 req/min resend limit
vi.mock("../../lib/rate-limit", () => ({
  rateLimit: () => async () => {},
}));

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, onboardingTokens } from "../../db/schema";
import { sendMail } from "../../lib/mailer";
import { stripe } from "../../lib/stripe";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

describe("Onboard Resend + Connect Refresh", () => {
  let app: any;

  // Seeded clients for resend tests
  let clientAId: string; // pending token
  let clientBId: string; // in_progress token
  let clientCId: string; // no token (lookup by email)

  // Extra clients created in refresh describe blocks — tracked for cleanup
  const extraClientIds: string[] = [];

  beforeAll(async () => {
    ensureBaseEnv();
    process.env.API_BASE_URL = "http://localhost:4242";

    clientAId = randomUUID();
    clientBId = randomUUID();
    clientCId = randomUUID();

    // clientA — has pending onboarding token
    await db.insert(clients).values({
      id: clientAId,
      name: "Resend Client A",
      email: `resend-a-${clientAId}@example.com`,
      status: "active",
    });
    await db.insert(onboardingTokens).values({
      id: randomUUID(),
      clientId: clientAId,
      token: randomBytes(32).toString("hex"),
      status: "pending",
      email: `resend-a-${clientAId}@example.com`,
    });

    // clientB — has in_progress token
    await db.insert(clients).values({
      id: clientBId,
      name: "Resend Client B",
      email: `resend-b-${clientBId}@example.com`,
      status: "active",
    });
    await db.insert(onboardingTokens).values({
      id: randomUUID(),
      clientId: clientBId,
      token: randomBytes(32).toString("hex"),
      status: "in_progress",
      email: `resend-b-${clientBId}@example.com`,
    });

    // clientC — no token
    await db.insert(clients).values({
      id: clientCId,
      name: "Resend Client C",
      email: `resend-c-${clientCId}@example.com`,
      status: "active",
    });

    app = await buildServer();
  });

  afterAll(async () => {
    // onboardingTokens cascade-delete when clients are deleted (onDelete: "cascade")
    await db
      .delete(clients)
      .where(eq(clients.id, clientAId))
      .catch(() => undefined);
    await db
      .delete(clients)
      .where(eq(clients.id, clientBId))
      .catch(() => undefined);
    await db
      .delete(clients)
      .where(eq(clients.id, clientCId))
      .catch(() => undefined);
    for (const id of extraClientIds) {
      await db
        .delete(clients)
        .where(eq(clients.id, id))
        .catch(() => undefined);
    }
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /onboard-client/resend ───────────────────────────────────────────

  describe("POST /api/v1/onboard-client/resend", () => {
    it("returns 200 by clientId and revokes old pending token", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId: clientAId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().clientId).toBe(clientAId);

      // Old pending token should now be revoked
      const tokens = await db
        .select()
        .from(onboardingTokens)
        .where(eq(onboardingTokens.clientId, clientAId));
      const revokedCount = tokens.filter((t) => t.status === "revoked").length;
      expect(revokedCount).toBeGreaterThanOrEqual(1);
    });

    it("returns 200 by clientId and revokes old in_progress token", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId: clientBId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().clientId).toBe(clientBId);

      const tokens = await db
        .select()
        .from(onboardingTokens)
        .where(eq(onboardingTokens.clientId, clientBId));
      const revokedCount = tokens.filter((t) => t.status === "revoked").length;
      expect(revokedCount).toBeGreaterThanOrEqual(1);
    });

    it("returns 200 by email for client with no prior token", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { email: `resend-c-${clientCId}@example.com` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().clientId).toBe(clientCId);

      // New token should have been created
      const tokens = await db
        .select()
        .from(onboardingTokens)
        .where(eq(onboardingTokens.clientId, clientCId));
      const pendingToken = tokens.find((t) => t.status === "pending");
      expect(pendingToken).toBeDefined();
    });

    it("sends email to correct address with onboarding subject", async () => {
      const token = makeAdminToken();

      await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId: clientAId },
      });

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: `resend-a-${clientAId}@example.com`,
          subject: "DFW Software Consulting - New Onboarding Link",
        })
      );
    });

    it("returns 400 when neither email nor clientId is provided", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/email.*clientId|clientId.*email/i);
    });

    it("returns 404 when clientId does not exist", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId: randomUUID() },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/client/i);
    });

    it("returns 404 when email does not match any client", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { email: "nobody@nowhere.example.com" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/client/i);
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { "content-type": "application/json" },
        payload: { clientId: clientAId },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /connect/refresh ──────────────────────────────────────────────────

  describe("GET /api/v1/connect/refresh", () => {
    // Helper: seed a fresh client + token pair; tracks clientId for cleanup
    async function seedRefreshPair(
      tokenStatus: "pending" | "in_progress" | "revoked" | "completed"
    ): Promise<{ clientId: string; tokenValue: string }> {
      const cId = randomUUID();
      const tValue = randomBytes(32).toString("hex");

      await db.insert(clients).values({
        id: cId,
        name: "Refresh Test Client",
        email: `refresh-${cId}@example.com`,
        status: "active",
      });
      await db.insert(onboardingTokens).values({
        id: randomUUID(),
        clientId: cId,
        token: tValue,
        status: tokenStatus,
        email: `refresh-${cId}@example.com`,
      });

      extraClientIds.push(cId);
      return { clientId: cId, tokenValue: tValue };
    }

    it("returns 302 redirect to Stripe account link for valid pending token", async () => {
      const { tokenValue } = await seedRefreshPair("pending");

      (stripe.accounts.create as any).mockResolvedValueOnce({ id: "acct_test_refresh" });
      (stripe.accountLinks.create as any).mockResolvedValueOnce({
        url: "https://connect.stripe.com/setup/mock_pending",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/connect/refresh?token=${tokenValue}`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://connect.stripe.com/setup/mock_pending");
    });

    it("returns 302 redirect for in_progress token", async () => {
      const { tokenValue } = await seedRefreshPair("in_progress");

      (stripe.accounts.create as any).mockResolvedValueOnce({ id: "acct_test_inprogress" });
      (stripe.accountLinks.create as any).mockResolvedValueOnce({
        url: "https://connect.stripe.com/setup/mock_inprogress",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/connect/refresh?token=${tokenValue}`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://connect.stripe.com/setup/mock_inprogress");
    });

    it("updates token status to in_progress after redirect", async () => {
      const { clientId, tokenValue } = await seedRefreshPair("pending");

      (stripe.accounts.create as any).mockResolvedValueOnce({ id: "acct_test_statuscheck" });
      (stripe.accountLinks.create as any).mockResolvedValueOnce({
        url: "https://connect.stripe.com/setup/mock_statuscheck",
      });

      await app.inject({
        method: "GET",
        url: `/api/v1/connect/refresh?token=${tokenValue}`,
      });

      const [updatedToken] = await db
        .select()
        .from(onboardingTokens)
        .where(eq(onboardingTokens.clientId, clientId))
        .limit(1);

      expect(updatedToken.status).toBe("in_progress");
    });

    it("returns 404 when token does not exist", async () => {
      const fakeToken = randomBytes(32).toString("hex");

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/connect/refresh?token=${fakeToken}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 when token is revoked", async () => {
      const { tokenValue } = await seedRefreshPair("revoked");

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/connect/refresh?token=${tokenValue}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 when token is completed", async () => {
      const { tokenValue } = await seedRefreshPair("completed");

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/connect/refresh?token=${tokenValue}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 502 when stripe.accountLinks.create throws", async () => {
      const { tokenValue } = await seedRefreshPair("pending");

      (stripe.accounts.create as any).mockResolvedValueOnce({ id: "acct_test_502" });
      (stripe.accountLinks.create as any).mockRejectedValueOnce(
        new Error("Stripe API unavailable")
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/connect/refresh?token=${tokenValue}`,
      });

      expect(response.statusCode).toBe(502);
    });
  });
});
