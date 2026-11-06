import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    products: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
    prices: { create: vi.fn() },
    taxRates: { list: vi.fn() },
  },
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients } from "../../db/schema";
import {
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
} from "../../lib/circuit-breakers";
import { stripe } from "../../lib/stripe";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

describe("Products API", () => {
  let app: any;
  // A client with a connected + charges-enabled Stripe account — the "happy path" client
  // that `resolveConnectedAccount` should resolve for all Stripe-calling routes.
  let clientId: string;
  let stripeAccountId: string;
  // A client that exists but has no connected/charges-enabled Stripe account — used to
  // cover the `resolveConnectedAccount` rejection path.
  let disconnectedClientId: string;

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCircuitBreakersForTests();

    clientId = randomUUID();
    stripeAccountId = `acct_products${clientId.replace(/-/g, "").slice(0, 14)}`;
    disconnectedClientId = randomUUID();

    await db.insert(clients).values({
      id: clientId,
      name: "Products Test Client",
      email: `products-${clientId}@example.com`,
      status: "active",
      stripeAccountId,
      chargesEnabled: true,
    });

    await db.insert(clients).values({
      id: disconnectedClientId,
      name: "Disconnected Client",
      email: `disconnected-${disconnectedClientId}@example.com`,
      status: "active",
      stripeAccountId: null,
      chargesEnabled: false,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    resetCircuitBreakersForTests();
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(clients).where(eq(clients.id, disconnectedClientId));
  });

  // ── GET /products ─────────────────────────────────────────────────────────

  describe("GET /api/v1/products", () => {
    it("returns 200 with formatted product list", async () => {
      const token = makeAdminToken();
      const mockPrice = { id: "price_1", unit_amount: 2500, currency: "usd" };
      const mockProducts = [
        {
          id: "prod_1",
          name: "Pro Plan",
          description: "Full access",
          default_price: mockPrice,
        },
        { id: "prod_2", name: "Basic Plan", description: null, default_price: null },
      ];

      (stripe.products.list as any).mockResolvedValueOnce({ data: mockProducts });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/products?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({
        id: "prod_1",
        name: "Pro Plan",
        description: "Full access",
        defaultPrice: { id: "price_1", amountCents: 2500, currency: "usd" },
      });
      expect(body[1].defaultPrice).toBeNull();
    });

    it("returns 200 with empty array when Stripe returns no products", async () => {
      const token = makeAdminToken();

      (stripe.products.list as any).mockResolvedValueOnce({ data: [] });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/products?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it("calls stripe.products.list with correct args", async () => {
      const token = makeAdminToken();

      (stripe.products.list as any).mockResolvedValueOnce({ data: [] });

      await app.inject({
        method: "GET",
        url: `/api/v1/products?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(stripe.products.list).toHaveBeenCalledWith(
        {
          active: true,
          limit: 100,
          expand: ["data.default_price"],
        },
        { stripeAccount: stripeAccountId }
      );
    });

    it("returns defaultPrice as null when default_price is a string ID (not expanded)", async () => {
      const token = makeAdminToken();
      const mockProducts = [
        { id: "prod_1", name: "Pro Plan", description: null, default_price: "price_string_id" },
      ];

      (stripe.products.list as any).mockResolvedValueOnce({ data: mockProducts });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/products?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].defaultPrice).toBeNull();
    });

    it("returns 400 when clientId query parameter is missing", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/clientId/i);
      expect(stripe.products.list).not.toHaveBeenCalled();
    });

    it("returns 400 when the client has no connected/charges-enabled Stripe account", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/products?clientId=${disconnectedClientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/connected stripe account/i);
      expect(stripe.products.list).not.toHaveBeenCalled();
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/products?clientId=${clientId}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 503 when the Stripe circuit is open", async () => {
      const token = makeAdminToken();
      openStripeCircuitForTests();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/products?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "Stripe service temporarily unavailable." });
    });
  });

  // ── POST /products ────────────────────────────────────────────────────────

  describe("POST /api/v1/products", () => {
    it("returns 201 with created product and price", async () => {
      const token = makeAdminToken();
      const mockProduct = { id: "prod_new", name: "New Plan", description: null };
      const mockPrice = { id: "price_new", unit_amount: 4900, currency: "usd" };

      (stripe.products.create as any).mockResolvedValueOnce(mockProduct);
      (stripe.prices.create as any).mockResolvedValueOnce(mockPrice);
      (stripe.products.update as any).mockResolvedValueOnce({});

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "New Plan", amountCents: 4900, clientId },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.id).toBe("prod_new");
      expect(body.name).toBe("New Plan");
      expect(body.defaultPrice).toEqual({ id: "price_new", amountCents: 4900, currency: "usd" });
    });

    it("returns 201 with description when provided", async () => {
      const token = makeAdminToken();
      const mockProduct = {
        id: "prod_desc",
        name: "Described Plan",
        description: "A description",
      };
      const mockPrice = { id: "price_desc", unit_amount: 999, currency: "usd" };

      (stripe.products.create as any).mockResolvedValueOnce(mockProduct);
      (stripe.prices.create as any).mockResolvedValueOnce(mockPrice);
      (stripe.products.update as any).mockResolvedValueOnce({});

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          name: "Described Plan",
          amountCents: 999,
          description: "A description",
          clientId,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().description).toBe("A description");
    });

    it("does not pass description to products.create when omitted", async () => {
      const token = makeAdminToken();
      const mockProduct = { id: "prod_nodesc", name: "No Desc", description: null };
      const mockPrice = { id: "price_nodesc", unit_amount: 500, currency: "usd" };

      (stripe.products.create as any).mockResolvedValueOnce(mockProduct);
      (stripe.prices.create as any).mockResolvedValueOnce(mockPrice);
      (stripe.products.update as any).mockResolvedValueOnce({});

      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "No Desc", amountCents: 500, clientId },
      });

      const callArgs = (stripe.products.create as any).mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("description");
      const callOpts = (stripe.products.create as any).mock.calls[0][1];
      expect(callOpts).toEqual(
        expect.objectContaining({
          stripeAccount: stripeAccountId,
          idempotencyKey: expect.any(String),
        })
      );
    });

    it("calls prices.create with correct product, unit_amount, and currency", async () => {
      const token = makeAdminToken();
      const mockProduct = { id: "prod_price_check", name: "Price Check", description: null };
      const mockPrice = { id: "price_check", unit_amount: 1500, currency: "eur" };

      (stripe.products.create as any).mockResolvedValueOnce(mockProduct);
      (stripe.prices.create as any).mockResolvedValueOnce(mockPrice);
      (stripe.products.update as any).mockResolvedValueOnce({});

      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Price Check", amountCents: 1500, currency: "eur", clientId },
      });

      expect(stripe.prices.create).toHaveBeenCalledWith(
        {
          product: "prod_price_check",
          unit_amount: 1500,
          currency: "eur",
        },
        expect.objectContaining({
          stripeAccount: stripeAccountId,
          idempotencyKey: expect.any(String),
        })
      );
    });

    it("defaults currency to usd", async () => {
      const token = makeAdminToken();
      const mockProduct = { id: "prod_usd", name: "USD Plan", description: null };
      const mockPrice = { id: "price_usd", unit_amount: 2000, currency: "usd" };

      (stripe.products.create as any).mockResolvedValueOnce(mockProduct);
      (stripe.prices.create as any).mockResolvedValueOnce(mockPrice);
      (stripe.products.update as any).mockResolvedValueOnce({});

      await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "USD Plan", amountCents: 2000, clientId },
      });

      expect(stripe.prices.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "usd" }),
        expect.objectContaining({ stripeAccount: stripeAccountId })
      );
    });

    it("archives the orphaned product when price creation fails", async () => {
      const token = makeAdminToken();
      const mockProduct = { id: "prod_orphan", name: "Orphan Plan", description: null };

      (stripe.products.create as any).mockResolvedValueOnce(mockProduct);
      (stripe.prices.create as any).mockRejectedValueOnce(new Error("price creation failed"));
      (stripe.products.update as any).mockResolvedValueOnce({});

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Orphan Plan", amountCents: 750, clientId },
      });

      expect(response.statusCode).toBe(500);
      expect(stripe.products.update).toHaveBeenCalledWith(
        "prod_orphan",
        { active: false },
        expect.objectContaining({ stripeAccount: stripeAccountId })
      );
    });

    it("returns 400 when name is missing", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { amountCents: 1000, clientId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/name/i);
    });

    it("returns 400 when name is blank whitespace", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "   ", amountCents: 1000, clientId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/name/i);
    });

    it("returns 400 when amountCents is zero", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Plan", amountCents: 0, clientId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountCents/i);
    });

    it("returns 400 when amountCents is a float", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Plan", amountCents: 9.99, clientId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountCents/i);
    });

    it("returns 400 when amountCents is negative", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Plan", amountCents: -100, clientId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountCents/i);
    });

    it("returns 400 when clientId is missing", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Plan", amountCents: 1000 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/clientId/i);
      expect(stripe.products.create).not.toHaveBeenCalled();
    });

    it("returns 400 when the client has no connected/charges-enabled Stripe account", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Plan", amountCents: 1000, clientId: disconnectedClientId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/connected stripe account/i);
      expect(stripe.products.create).not.toHaveBeenCalled();
    });

    it("returns 404 when the client does not exist", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Plan", amountCents: 1000, clientId: randomUUID() },
      });

      expect(response.statusCode).toBe(404);
      expect(stripe.products.create).not.toHaveBeenCalled();
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { "content-type": "application/json" },
        payload: { name: "Plan", amountCents: 1000, clientId },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /tax-rates ──────────────────────────────────────────────────────────

  describe("GET /api/v1/tax-rates", () => {
    it("returns 200 with formatted tax rate list", async () => {
      const token = makeAdminToken();
      const mockTaxRates = [
        {
          id: "txr_1",
          display_name: "Sales Tax",
          description: "State sales tax",
          percentage: 8.25,
          inclusive: false,
          jurisdiction: "CA",
        },
        {
          id: "txr_2",
          display_name: "VAT",
          description: null,
          percentage: 20,
          inclusive: true,
          jurisdiction: null,
        },
      ];

      (stripe.taxRates.list as any).mockResolvedValueOnce({ data: mockTaxRates });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tax-rates?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({
        id: "txr_1",
        displayName: "Sales Tax",
        description: "State sales tax",
        percentage: 8.25,
        inclusive: false,
        jurisdiction: "CA",
      });
      expect(body[1].description).toBeNull();
      expect(body[1].jurisdiction).toBeNull();
    });

    it("returns 200 with empty array when no tax rates", async () => {
      const token = makeAdminToken();

      (stripe.taxRates.list as any).mockResolvedValueOnce({ data: [] });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tax-rates?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it("calls stripe.taxRates.list with correct args", async () => {
      const token = makeAdminToken();

      (stripe.taxRates.list as any).mockResolvedValueOnce({ data: [] });

      await app.inject({
        method: "GET",
        url: `/api/v1/tax-rates?clientId=${clientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(stripe.taxRates.list).toHaveBeenCalledWith(
        {
          active: true,
          limit: 100,
        },
        { stripeAccount: stripeAccountId }
      );
    });

    it("returns 400 when clientId query parameter is missing", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/tax-rates",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/clientId/i);
      expect(stripe.taxRates.list).not.toHaveBeenCalled();
    });

    it("returns 400 when the client has no connected/charges-enabled Stripe account", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tax-rates?clientId=${disconnectedClientId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/connected stripe account/i);
      expect(stripe.taxRates.list).not.toHaveBeenCalled();
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tax-rates?clientId=${clientId}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
