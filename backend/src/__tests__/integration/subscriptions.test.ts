import { vi } from "vitest";

// Use vi.hoisted so stripeMock is available when vi.mock factories are called
const { stripeMock } = vi.hoisted(() => {
  const stripeMock = {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    customers: { create: vi.fn() },
    prices: { create: vi.fn() },
    subscriptions: {
      create: vi.fn(),
      retrieve: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
    },
    taxRates: {
      retrieve: vi.fn(),
    },
    invoices: {
      retrieve: vi.fn(),
      finalizeInvoice: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      voidInvoice: vi.fn(),
    },
    invoiceItems: { create: vi.fn() },
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients } from "../../db/schema";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";
import { makeStripeInvoice, makeStripeSub } from "../helpers/stripe-factories";

describe("Subscriptions API", () => {
  let app: any;
  let clientId: string;
  const workspace = "client_portal";

  beforeAll(async () => {
    ensureBaseEnv();

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
    stripeMock.customers.create.mockResolvedValue({ id: "cus_test_001" });
    stripeMock.prices.create.mockResolvedValue({ id: "price_test_001" });
    stripeMock.invoiceItems.create.mockResolvedValue({ id: "ii_test_001" });
    stripeMock.subscriptions.create.mockResolvedValue(
      makeStripeSub({ metadata: { clientId, description: "Basic plan", interval: "monthly" } })
    );
    stripeMock.invoices.retrieve.mockResolvedValue(makeStripeInvoice());
    stripeMock.invoices.finalizeInvoice.mockResolvedValue(makeStripeInvoice());
    stripeMock.invoices.create.mockResolvedValue(makeStripeInvoice({ status: "draft" }));
    stripeMock.invoices.voidInvoice.mockResolvedValue(makeStripeInvoice({ status: "void" }));
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      makeStripeSub({ metadata: { clientId, description: "Basic plan", interval: "monthly" } })
    );
    stripeMock.taxRates.retrieve.mockResolvedValue({ id: "txr_default" });
    stripeMock.invoices.list.mockResolvedValue({ data: [] });
    stripeMock.subscriptions.update.mockImplementation((_id: string, params: any) =>
      Promise.resolve(makeStripeSub(params))
    );
    // Add subscription schedules mock
    stripeMock.subscriptionSchedules = {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
      cancel: vi.fn(),
    };
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
        payload: {
          clientId,
          workspace,
          amountCents: 1999,
          description: "Basic plan",
          interval: "monthly",
        },
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
      // For legacy format with totalPayments, a subscription schedule is created
      stripeMock.subscriptionSchedules = {
        create: vi.fn().mockResolvedValueOnce({
          id: "sub_sched_test_001",
          status: "active",
          customer: "cus_test_001",
          metadata: {
            clientId,
            description: "Limited plan",
            interval: "quarterly",
            totalPayments: "4",
            amountPerPaymentCents: "2500",
          },
          phases: [
            {
              items: [{ price: "price_test_001" }],
              start_date: Math.floor(Date.now() / 1000),
              end_date: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
            },
          ],
          created: Math.floor(Date.now() / 1000),
        }),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
        list: vi.fn().mockResolvedValue({ data: [] }),
      };
      stripeMock.prices.create.mockResolvedValueOnce({ id: "price_test_001" });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          clientId,
          workspace,
          amountCents: 2500,
          description: "Limited plan",
          interval: "quarterly",
          totalPayments: 4,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().subscription.totalPayments).toBe(4);
    });

    it("maps quarterly interval to Stripe month interval_count=3", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          clientId,
          workspace,
          amountCents: 3000,
          description: "Quarterly plan",
          interval: "quarterly",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(stripeMock.prices.create).toHaveBeenCalledWith(
        expect.objectContaining({
          recurring: { interval: "month", interval_count: 3 },
        })
      );
    });

    it("returns 400 when taxRateId is invalid", async () => {
      stripeMock.taxRates.retrieve.mockRejectedValueOnce(new Error("No such tax rate"));

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: {
          clientId,
          workspace,
          amountCents: 1000,
          description: "Plan",
          interval: "monthly",
          taxRateId: "txr_bad",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/Invalid taxRateId/i);
      expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
    });

    it("applies tax settings to price and subscription when taxRateId is provided", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          clientId,
          workspace,
          amountCents: 2200,
          description: "Taxed plan",
          interval: "monthly",
          taxRateId: "txr_123",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(stripeMock.taxRates.retrieve).toHaveBeenCalledWith("txr_123");
      expect(stripeMock.prices.create).toHaveBeenCalledWith(
        expect.objectContaining({ tax_behavior: "exclusive" })
      );
      expect(stripeMock.subscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          default_tax_rates: ["txr_123"],
          metadata: expect.objectContaining({ taxRateId: "txr_123" }),
        })
      );
    });

    it("returns 400 when clientId is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { workspace, amountCents: 1000, description: "Plan", interval: "monthly" },
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
        payload: { clientId, workspace, amountCents: 0, description: "Plan", interval: "monthly" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountPerPaymentCents/i);
    });

    it("returns 400 when amountCents is a float", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: {
          clientId,
          workspace,
          amountCents: 10.5,
          description: "Plan",
          interval: "monthly",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountPerPaymentCents/i);
    });

    it("returns 400 when description is blank", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: {
          clientId,
          workspace,
          amountCents: 1000,
          description: "   ",
          interval: "monthly",
        },
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
        payload: {
          clientId,
          workspace,
          amountCents: 1000,
          description: "Plan",
          interval: "weekly",
        },
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
          workspace,
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
          workspace,
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
        payload: {
          clientId,
          workspace,
          amountCents: 1000,
          description: "Plan",
          interval: "monthly",
        },
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
          makeStripeSub({
            metadata: { clientId, description: "Hosting", interval: "monthly" },
          }),
        ],
      });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({ data: [] }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions?workspace=${workspace}`,
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
        email: `nostripe-${unknownClientId}@test.com`,
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions?workspace=${workspace}&clientId=${unknownClientId}`,
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
        makeStripeSub({
          id: subId,
          metadata: { clientId, description: "Hosting", interval: "monthly" },
        })
      );
      stripeMock.invoices.list.mockResolvedValueOnce({ data: [makeStripeInvoice()] });

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
      stripeMock.subscriptionSchedules = {
        retrieve: vi.fn().mockRejectedValueOnce(new Error("No such subscription schedule")),
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

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
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(makeStripeSub({ status: "active" }));
      stripeMock.subscriptions.update.mockResolvedValueOnce(
        makeStripeSub({ pause_collection: { behavior: "void" } })
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
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(makeStripeSub({ status: "active" }));
      stripeMock.subscriptions.update.mockResolvedValueOnce(
        makeStripeSub({
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

    it("returns 200 and resumes a paused subscription", async () => {
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
        makeStripeSub({ status: "active", pause_collection: { behavior: "void" } })
      );
      stripeMock.subscriptions.update.mockResolvedValueOnce(
        makeStripeSub({ status: "active", pause_collection: null })
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

      expect(response.statusCode).toBe(200);
      expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(
        "sub_test_001",
        expect.objectContaining({ pause_collection: "" })
      );
    });

    it("returns 422 when attempting to modify a cancelled (Stripe 'canceled') subscription", async () => {
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
        makeStripeSub({ status: "canceled" })
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
      stripeMock.subscriptions.retrieve.mockResolvedValueOnce(makeStripeSub({ status: "active" }));
      stripeMock.subscriptions.update.mockResolvedValueOnce(
        makeStripeSub({
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
      stripeMock.subscriptionSchedules = {
        retrieve: vi.fn().mockRejectedValueOnce(new Error("No such subscription schedule")),
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

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

  // ── Dashboard Endpoints ───────────────────────────────────────────────────

  describe("GET /api/v1/subscriptions/dashboard/summary", () => {
    it("returns subscription summary stats", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({
        data: [
          makeStripeSub({ status: "active", metadata: { clientId, interval: "month" } }),
          makeStripeSub({ status: "canceled", metadata: { clientId, interval: "month" } }),
        ],
      });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            { id: "sched_1", status: "active", metadata: { clientId, interval: "month" } },
            { id: "sched_2", status: "completed", metadata: { clientId, interval: "month" } },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/summary?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("recurring");
      expect(body).toHaveProperty("paymentPlans");
      expect(body).toHaveProperty("total");
    });

    it("returns zeroed summary when Stripe lists are empty", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [] });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({ data: [] }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/summary?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().total.active).toBe(0);
      expect(response.json().total.cancelled).toBe(0);
    });
  });

  describe("GET /api/v1/subscriptions/dashboard/active", () => {
    it("returns active subscriptions list", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({
        data: [
          makeStripeSub({
            status: "active",
            metadata: { clientId, interval: "month" },
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          }),
        ],
      });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            {
              id: "sched_active",
              status: "active",
              metadata: { clientId, interval: "month", amountPerPaymentCents: "1000" },
              phases: [{ items: [{ plan: { amount: 1000 } }], start_date: Date.now() / 1000 }],
            },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/active?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json())).toBe(true);
    });

    it("returns null nextPaymentDate when current_period_end is missing", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({
        data: [
          makeStripeSub({
            status: "active",
            metadata: { clientId, interval: "month" },
            current_period_end: undefined,
          }),
        ],
      });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({ data: [] }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/active?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].nextPaymentDate).toBeNull();
    });

    it("uses phase plan amount fallback when active schedule metadata amount is missing", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [] });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            {
              id: "sched_active_plan_fallback",
              status: "active",
              metadata: { clientId, interval: "month" },
              phases: [{ items: [{ plan: { amount: 4200 } }], start_date: Date.now() / 1000 }],
            },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/active?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].amountPerPaymentCents).toBe(4200);
    });

    it("returns empty array when there are no active subscriptions or schedules", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [] });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({ data: [] }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/active?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe("GET /api/v1/subscriptions/dashboard/overdue", () => {
    it("returns overdue subscriptions", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({
        data: [
          makeStripeSub({
            status: "past_due",
            metadata: { clientId, interval: "month" },
            current_period_end: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
          }),
        ],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/overdue?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json())).toBe(true);
    });

    it("returns null pastDueSince when subscription has no current_period_end", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({
        data: [
          makeStripeSub({
            status: "past_due",
            metadata: { clientId, interval: "month" },
            current_period_end: undefined,
          }),
        ],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/overdue?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].pastDueSince).toBeNull();
    });

    it("returns empty array when there are no overdue subscriptions", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [] });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/overdue?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe("GET /api/v1/subscriptions/dashboard/ending-soon", () => {
    it("returns payment plans ending soon", async () => {
      const token = makeAdminToken();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() + 15);
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            {
              id: "sched_ending",
              status: "active",
              metadata: { clientId, interval: "month", amountPerPaymentCents: "1000" },
              phases: [
                {
                  items: [{ plan: { amount: 1000 } }],
                  end_date: Math.floor(cutoffDate.getTime() / 1000),
                },
              ],
            },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/ending-soon?workspace=${workspace}&days=30`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json())).toBe(true);
    });

    it("uses phase plan amount fallback when metadata amount is missing", async () => {
      const token = makeAdminToken();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() + 10);

      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            {
              id: "sched_fallback_amount",
              status: "active",
              metadata: { clientId, interval: "month" },
              phases: [
                {
                  items: [{ plan: { amount: 2750 } }],
                  end_date: Math.floor(cutoffDate.getTime() / 1000),
                },
              ],
            },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/ending-soon?workspace=${workspace}&days=30`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].amountPerPaymentCents).toBe(2750);
    });

    it("returns null endDate when schedule phase has no end_date", async () => {
      const token = makeAdminToken();

      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            {
              id: "sched_no_end_date",
              status: "active",
              metadata: { clientId, interval: "month", amountPerPaymentCents: "1000" },
              phases: [{ items: [{ plan: { amount: 1000 } }], end_date: undefined }],
            },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/ending-soon?workspace=${workspace}&days=30`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe("GET /api/v1/subscriptions/dashboard/recently-cancelled", () => {
    it("returns recently cancelled subscriptions", async () => {
      const token = makeAdminToken();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 15);
      stripeMock.subscriptions.list.mockResolvedValueOnce({
        data: [
          makeStripeSub({
            status: "canceled",
            metadata: { clientId, interval: "month" },
            canceled_at: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
          }),
        ],
      });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            {
              id: "sched_cancelled",
              status: "canceled",
              metadata: { clientId, interval: "month", amountPerPaymentCents: "1000" },
              canceled_at: Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60,
            },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/recently-cancelled?workspace=${workspace}&days=30`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json())).toBe(true);
    });

    it("uses zero amount fallback for cancelled schedules without metadata amount", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [] });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            {
              id: "sched_cancelled_no_amount",
              status: "canceled",
              metadata: { clientId, interval: "month" },
              canceled_at: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
            },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/recently-cancelled?workspace=${workspace}&days=30`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].amountPerPaymentCents).toBe(0);
    });

    it("returns empty array when there are no recently cancelled records", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [] });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({ data: [] }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/subscriptions/dashboard/recently-cancelled?workspace=${workspace}&days=30`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe("GET /api/v1/clients/:clientId/subscriptions", () => {
    it("returns full subscription details for one client", async () => {
      const token = makeAdminToken();
      stripeMock.subscriptions.list.mockResolvedValueOnce({
        data: [
          makeStripeSub({
            status: "active",
            metadata: { clientId, interval: "month" },
            customer: "cus_test_001",
          }),
        ],
      });
      stripeMock.subscriptionSchedules = {
        list: vi.fn().mockResolvedValueOnce({
          data: [
            {
              id: "sched_client",
              status: "active",
              metadata: {
                clientId,
                interval: "month",
                amountPerPaymentCents: "1000",
                startDate: "2024-01-01",
              },
              phases: [
                {
                  items: [{ plan: { amount: 1000 } }],
                  start_date: Math.floor(Date.now() / 1000),
                  end_date: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
                },
              ],
              created: Math.floor(Date.now() / 1000),
            },
          ],
        }),
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        cancel: vi.fn(),
      };
      stripeMock.invoices.list.mockResolvedValueOnce({ data: [] });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients/${clientId}/subscriptions?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(
        response.statusCode,
        `Expected 200 but got ${response.statusCode}: ${JSON.stringify(response.json())}`
      ).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("client");
      expect(body).toHaveProperty("subscriptions");
      expect(body).toHaveProperty("invoices");
    });

    it("returns 404 when client does not exist", async () => {
      const token = makeAdminToken();
      const nonExistentId = randomUUID();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients/${nonExistentId}/subscriptions?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/not found/i);
    });

    it("returns 400 when client belongs to different workspace", async () => {
      const token = makeAdminToken();
      const otherWorkspaceClientId = randomUUID();
      await db.insert(clients).values({
        id: otherWorkspaceClientId,
        name: "Other Workspace Client",
        email: `other-${otherWorkspaceClientId}@test.com`,
        workspace: "dfwsc_services",
        status: "active",
        stripeCustomerId: "cus_other_workspace",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients/${otherWorkspaceClientId}/subscriptions?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      const responseBody = response.json();
      expect(response.statusCode).toBe(400);
      expect(responseBody.error).toMatch(/does not belong/i);

      await db.delete(clients).where(eq(clients.id, otherWorkspaceClientId));
    });

    it("returns empty arrays when client has no stripeCustomerId", async () => {
      const token = makeAdminToken();
      const noStripeClientId = randomUUID();
      await db.insert(clients).values({
        id: noStripeClientId,
        name: "No Stripe Client",
        email: `nostripe-${noStripeClientId}@test.com`,
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients/${noStripeClientId}/subscriptions?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("client");
      expect(body.client.id).toBe(noStripeClientId);
      expect(body.subscriptions).toEqual([]);
      expect(body.invoices).toEqual([]);

      await db.delete(clients).where(eq(clients.id, noStripeClientId));
    });
  });
});
