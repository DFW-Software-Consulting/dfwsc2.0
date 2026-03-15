import { vi } from "vitest";

// Use vi.hoisted so stripeMock is available when vi.mock factories are called
const { stripeMock } = vi.hoisted(() => {
  const makeStripeSub = (overrides: Record<string, any> = {}) => ({
    id: "sub_test_001",
    object: "subscription",
    status: "active",
    pause_collection: null,
    items: { data: [{ price: { unit_amount: 4900 } }] },
    metadata: { clientId: "", description: "Monthly hosting", interval: "monthly" },
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    created: Math.floor(Date.now() / 1000),
    latest_invoice: "in_test_001",
    ...overrides,
  });

  const makeStripeInvoice = (overrides: Record<string, any> = {}) => ({
    id: "in_test_001",
    object: "invoice",
    amount_due: 4900,
    description: "Monthly hosting",
    due_date: Math.floor(Date.now() / 1000) + 86400 * 30,
    status: "open",
    hosted_invoice_url: "https://invoice.stripe.com/i/test",
    status_transitions: { paid_at: null },
    created: Math.floor(Date.now() / 1000),
    metadata: {},
    ...overrides,
  });

  const stripeMock = {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_test_001" }),
    },
    prices: {
      create: vi.fn().mockResolvedValue({ id: "price_test_001" }),
    },
    subscriptions: {
      create: vi.fn().mockResolvedValue(makeStripeSub()),
      retrieve: vi.fn().mockResolvedValue(makeStripeSub()),
      list: vi.fn().mockResolvedValue({ data: [] }),
      update: vi
        .fn()
        .mockImplementation((_id: string, params: any) => Promise.resolve(makeStripeSub(params))),
    },
    invoices: {
      retrieve: vi.fn().mockResolvedValue(makeStripeInvoice()),
      finalizeInvoice: vi.fn().mockResolvedValue(makeStripeInvoice()),
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue(makeStripeInvoice({ status: "draft" })),
      voidInvoice: vi.fn().mockResolvedValue(makeStripeInvoice({ status: "void" })),
    },
    invoiceItems: {
      create: vi.fn().mockResolvedValue({ id: "ii_test_001" }),
    },
    _makeStripeSub: makeStripeSub,
    _makeStripeInvoice: makeStripeInvoice,
  };

  return { stripeMock };
});

vi.mock("../../lib/stripe", () => ({ stripe: stripeMock }));

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
import { clients } from "../../db/schema";

const TEST_JWT_SECRET = "test_jwt_secret_minimum_32_characters_long_random_string";

function makeAdminToken() {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

describe("Subscriptions API", () => {
  let app: any;
  let clientId: string;

  beforeAll(async () => {
    process.env.FRONTEND_ORIGIN ??= "http://localhost:5173";
    process.env.USE_CHECKOUT ??= "false";
    process.env.SMTP_HOST ??= "mailhog";
    process.env.SMTP_PORT ??= "1025";
    process.env.SMTP_USER ??= "test";
    process.env.SMTP_PASS ??= "test";

    clientId = randomUUID();

    await db.insert(clients).values({
      id: clientId,
      name: "Sub Test Client",
      email: "sub-test@example.com",
      status: "active",
    });

    app = await buildServer();
  });

  afterAll(async () => {
    await db
      .delete(clients)
      .where(eq(clients.id, clientId))
      .catch(() => undefined);
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock implementations
    const makeStripeSub = stripeMock._makeStripeSub;
    const makeStripeInvoice = stripeMock._makeStripeInvoice;
    stripeMock.subscriptions.create.mockResolvedValue(
      makeStripeSub({ metadata: { clientId, description: "Basic plan", interval: "monthly" } })
    );
    stripeMock.invoices.retrieve.mockResolvedValue(makeStripeInvoice());
    stripeMock.invoices.finalizeInvoice.mockResolvedValue(makeStripeInvoice());
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      makeStripeSub({ metadata: { clientId, description: "Basic plan", interval: "monthly" } })
    );
    stripeMock.invoices.list.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /subscriptions ───────────────────────────────────────────────────

  describe("POST /api/v1/subscriptions", () => {
    it("returns 201 with subscription and hostedInvoiceUrl for valid request", async () => {
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
      expect(body.hostedInvoiceUrl).toBeDefined();
      expect(body.subscription.clientId).toBe(clientId);
      expect(body.subscription.interval).toBe("monthly");
      expect(stripeMock.prices.create).toHaveBeenCalledOnce();
      expect(stripeMock.subscriptions.create).toHaveBeenCalledOnce();
    });

    it("returns 201 with totalPayments in metadata when provided", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.create.mockResolvedValueOnce(
        stripeMock._makeStripeSub({
          metadata: {
            clientId,
            description: "Limited plan",
            interval: "quarterly",
            totalPayments: "4",
          },
        })
      );

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
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { amountCents: 1000, description: "Plan", interval: "monthly" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/clientId/i);
    });

    it("returns 400 when amountCents is zero", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { clientId, amountCents: 0, description: "Plan", interval: "monthly" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountCents/i);
    });

    it("returns 400 when amountCents is a float", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { clientId, amountCents: 10.5, description: "Plan", interval: "monthly" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountCents/i);
    });

    it("returns 400 when description is blank", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { clientId, amountCents: 1000, description: "   ", interval: "monthly" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/description/i);
    });

    it("returns 400 when interval is invalid", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { clientId, amountCents: 1000, description: "Plan", interval: "weekly" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/interval/i);
    });

    it("returns 400 when totalPayments is zero", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
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
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
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
    it("returns 200 with array from Stripe", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({
        data: [
          stripeMock._makeStripeSub({
            metadata: { clientId, description: "Hosting", interval: "monthly" },
          }),
        ],
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json())).toBe(true);
    });

    it("returns empty array for clientId with no stripeCustomerId", async () => {
      const unknownClientId = randomUUID();
      await db.insert(clients).values({
        id: unknownClientId,
        name: "No Stripe",
        email: "nostripe@test.com",
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions?clientId=${unknownClientId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);

      await db
        .delete(clients)
        .where(eq(clients.id, unknownClientId))
        .catch(() => undefined);
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/subscriptions" });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /subscriptions/:id ────────────────────────────────────────────────

  describe("GET /api/v1/subscriptions/:id", () => {
    it("returns 200 with subscription and invoices array", async () => {
      const subId = "sub_test_001";
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
        stripeMock._makeStripeSub({
          id: subId,
          metadata: { clientId, description: "Hosting", interval: "monthly" },
        })
      );
      stripeMock.invoices.list.mockResolvedValueOnce({ data: [stripeMock._makeStripeInvoice()] });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/${subId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(subId);
      expect(Array.isArray(body.invoices)).toBe(true);
      expect(body.invoices.length).toBeGreaterThanOrEqual(1);
    });

    it("returns 404 for unknown id", async () => {
      stripeMock.subscriptions.retrieve.mockRejectedValueOnce(new Error("No such subscription"));

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/${randomUUID()}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/not found/i);
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/subscriptions/sub_test_001",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── PATCH /subscriptions/:id ──────────────────────────────────────────────

  describe("PATCH /api/v1/subscriptions/:id", () => {
    it("returns 200 and pauses subscription", async () => {
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
        stripeMock._makeStripeSub({ status: "active" })
      );
      stripeMock.subscriptions.update.mockResolvedValueOnce(
        stripeMock._makeStripeSub({ pause_collection: { behavior: "void" } })
      );

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { status: "paused" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("paused");
      expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(
        "sub_test_001",
        expect.objectContaining({ pause_collection: { behavior: "void" } })
      );
    });

    it("returns 200 and cancels subscription", async () => {
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
        stripeMock._makeStripeSub({ status: "active" })
      );
      stripeMock.subscriptions.update.mockResolvedValueOnce(
        stripeMock._makeStripeSub({
          cancel_at_period_end: true,
          metadata: { clientId, description: "", interval: "monthly" },
        })
      );

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { status: "cancelled" },
      });

      expect(response.statusCode).toBe(200);
      expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(
        "sub_test_001",
        expect.objectContaining({ cancel_at_period_end: true })
      );
    });

    it("returns 422 when attempting to modify a cancelled (Stripe 'canceled') subscription", async () => {
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
        stripeMock._makeStripeSub({ status: "canceled" })
      );

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { status: "active" },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/cancelled/i);
    });

    it("returns 400 when amountCents is sent", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { amountCents: 9999 },
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 400 when description is sent", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { description: "New description" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 200 and updates totalPayments metadata", async () => {
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
        stripeMock._makeStripeSub({ status: "active" })
      );
      stripeMock.subscriptions.update.mockResolvedValueOnce(
        stripeMock._makeStripeSub({
          metadata: { clientId, description: "Hosting", interval: "monthly", totalPayments: "6" },
        })
      );

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { totalPayments: 6 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().totalPayments).toBe(6);
    });

    it("returns 422 when totalPayments is 0", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { totalPayments: 0 },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/totalPayments/i);
    });

    it("returns 422 when totalPayments is a float", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { totalPayments: 1.5 },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/totalPayments/i);
    });

    it("returns 404 for unknown id", async () => {
      stripeMock.subscriptions.retrieve.mockRejectedValueOnce(new Error("No such subscription"));

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/subscriptions/${randomUUID()}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { status: "paused" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/not found/i);
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/subscriptions/sub_test_001",
        headers: { "content-type": "application/json" },
        payload: { status: "paused" },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
