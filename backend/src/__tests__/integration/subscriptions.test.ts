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

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, invoices, subscriptions } from "../../db/schema";

const TEST_JWT_SECRET = "test_jwt_secret_minimum_32_characters_long_random_string";

function makeAdminToken() {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

describe("Subscriptions API", () => {
  let app: any;
  let clientId: string;
  let subId: string;
  let invoiceId: string;

  beforeAll(async () => {
    process.env.FRONTEND_ORIGIN ??= "http://localhost:5173";
    process.env.USE_CHECKOUT ??= "false";
    process.env.SMTP_HOST ??= "mailhog";
    process.env.SMTP_PORT ??= "1025";
    process.env.SMTP_USER ??= "test";
    process.env.SMTP_PASS ??= "test";

    clientId = randomUUID();
    subId = randomUUID();
    invoiceId = randomUUID();

    await db.insert(clients).values({
      id: clientId,
      name: "Sub Test Client",
      email: "sub-test@example.com",
      status: "active",
    });

    await db.insert(subscriptions).values({
      id: subId,
      clientId,
      amountCents: 4900,
      description: "Monthly hosting",
      interval: "monthly",
      status: "active",
      paymentsMade: 0,
      nextBillingDate: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(invoices).values({
      id: invoiceId,
      clientId,
      subscriptionId: subId,
      amountCents: 4900,
      description: "Monthly hosting",
      dueDate: new Date(),
      status: "pending",
      paymentToken: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    app = await buildServer();
  });

  afterAll(async () => {
    // FK-safe order: invoices → subscriptions → clients
    await db
      .delete(invoices)
      .where(eq(invoices.clientId, clientId))
      .catch(() => undefined);
    await db
      .delete(subscriptions)
      .where(eq(subscriptions.clientId, clientId))
      .catch(() => undefined);
    await db
      .delete(clients)
      .where(eq(clients.id, clientId))
      .catch(() => undefined);
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /subscriptions ───────────────────────────────────────────────────

  describe("POST /api/v1/subscriptions", () => {
    it("returns 201 with subscription + first invoice for valid request", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId, amountCents: 1999, description: "Basic plan", interval: "monthly" },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.subscription).toBeDefined();
      expect(body.invoice).toBeDefined();
      expect(body.subscription.clientId).toBe(clientId);
      expect(body.subscription.amountCents).toBe(1999);
      expect(body.subscription.interval).toBe("monthly");
      expect(body.invoice.status).toBe("pending");
    });

    it("returns 201 with totalPayments when provided", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          clientId,
          amountCents: 2500,
          description: "Limited plan",
          interval: "quarterly",
          totalPayments: 4,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().subscription.totalPayments).toBe(4);
    });

    it("returns 400 when clientId is missing", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { amountCents: 1000, description: "Plan", interval: "monthly" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/clientId/i);
    });

    it("returns 400 when amountCents is zero", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId, amountCents: 0, description: "Plan", interval: "monthly" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountCents/i);
    });

    it("returns 400 when amountCents is a float", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId, amountCents: 10.5, description: "Plan", interval: "monthly" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountCents/i);
    });

    it("returns 400 when description is blank", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId, amountCents: 1000, description: "   ", interval: "monthly" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/description/i);
    });

    it("returns 400 when interval is invalid", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId, amountCents: 1000, description: "Plan", interval: "weekly" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/interval/i);
    });

    it("returns 400 when totalPayments is zero", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          clientId,
          amountCents: 1000,
          description: "Plan",
          interval: "monthly",
          totalPayments: 0,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/totalPayments/i);
    });

    it("returns 404 when client does not exist", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          clientId: randomUUID(),
          amountCents: 1000,
          description: "Plan",
          interval: "monthly",
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/client/i);
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { "content-type": "application/json" },
        payload: { clientId, amountCents: 1000, description: "Plan", interval: "monthly" },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /subscriptions ────────────────────────────────────────────────────

  describe("GET /api/v1/subscriptions", () => {
    it("returns 200 with array containing seeded subscription", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      const found = body.find((s: any) => s.id === subId);
      expect(found).toBeDefined();
    });

    it("filters by clientId query parameter", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.every((s: any) => s.clientId === clientId)).toBe(true);
    });

    it("returns empty array for unknown clientId", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions?clientId=${randomUUID()}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it("response includes clientName", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const found = body.find((s: any) => s.id === subId);
      expect(found?.clientName).toBe("Sub Test Client");
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/subscriptions",
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /subscriptions/:id ────────────────────────────────────────────────

  describe("GET /api/v1/subscriptions/:id", () => {
    it("returns 200 with subscription and invoices array", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/${subId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(subId);
      expect(Array.isArray(body.invoices)).toBe(true);
      expect(body.invoices.length).toBeGreaterThanOrEqual(1);
      expect(body.invoices.find((i: any) => i.id === invoiceId)).toBeDefined();
    });

    it("returns 404 for unknown id", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/${randomUUID()}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/not found/i);
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/${subId}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ── PATCH /subscriptions/:id ──────────────────────────────────────────────

  describe("PATCH /api/v1/subscriptions/:id", () => {
    // Inserts a fresh sub directly into DB; cleaned up by afterAll via clientId
    async function seedPatchSub(
      status: "active" | "paused" | "cancelled" | "completed" = "active"
    ): Promise<string> {
      const id = randomUUID();
      await db.insert(subscriptions).values({
        id,
        clientId,
        amountCents: 1000,
        description: "Patch test sub",
        interval: "monthly",
        status,
        paymentsMade: 0,
        nextBillingDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return id;
    }

    it("returns 200 and sets status to paused", async () => {
      const freshId = await seedPatchSub("active");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { status: "paused" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("paused");
    });

    it("returns 200 and sets status to cancelled", async () => {
      const freshId = await seedPatchSub("active");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { status: "cancelled" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("cancelled");
    });

    it("returns 200 and resumes a paused subscription to active", async () => {
      const freshId = await seedPatchSub("paused");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { status: "active" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("active");
    });

    it("returns 422 when attempting to resume a cancelled subscription", async () => {
      const freshId = await seedPatchSub("cancelled");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { status: "active" },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/cancelled/i);
    });

    it("returns 422 when attempting to set status to completed", async () => {
      const freshId = await seedPatchSub("active");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { status: "completed" },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/paused.*cancelled.*active/i);
    });

    it("returns 422 when modifying a completed subscription", async () => {
      const freshId = await seedPatchSub("completed");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { status: "cancelled" },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/completed/i);
    });

    it("returns 404 for unknown id", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${randomUUID()}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { status: "paused" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/not found/i);
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${subId}`,
        headers: { "content-type": "application/json" },
        payload: { status: "paused" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 200 and updates totalPayments to 6", async () => {
      const freshId = await seedPatchSub("active");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { totalPayments: 6 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().totalPayments).toBe(6);
    });

    it("returns 200 and clears totalPayments to null (indefinite)", async () => {
      const freshId = await seedPatchSub("active");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { totalPayments: null },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().totalPayments).toBeNull();
    });

    it("returns 422 when totalPayments is 0", async () => {
      const freshId = await seedPatchSub("active");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { totalPayments: 0 },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/totalPayments/i);
    });

    it("returns 422 when totalPayments is a float", async () => {
      const freshId = await seedPatchSub("active");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { totalPayments: 1.5 },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/totalPayments/i);
    });

    it("returns 422 when editing a completed subscription", async () => {
      const freshId = await seedPatchSub("completed");
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${freshId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { totalPayments: 6 },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/completed/i);
    });
  });
});
