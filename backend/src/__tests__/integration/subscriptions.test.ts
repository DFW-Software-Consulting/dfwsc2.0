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
    stripeMock.invoices.list.mockResolvedValue({ data: [] });
    stripeMock.subscriptions.update.mockImplementation((_id: string, params: any) =>
      Promise.resolve(makeStripeSub(params))
    );
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
      stripeMock.subscriptions.create.mockResolvedValueOnce(
        makeStripeSub({
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
        payload: {
          clientId,
          workspace,
          amountCents: 10.5,
          description: "Plan",
          interval: "monthly",
        },
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
        email: "nostripe@test.com",
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
