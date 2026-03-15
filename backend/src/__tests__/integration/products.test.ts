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
  },
}));

import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { stripe } from "../../lib/stripe";

const TEST_JWT_SECRET = "test_jwt_secret_minimum_32_characters_long_random_string";

function makeAdminToken() {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

describe("Products API", () => {
  let app: any;

  beforeAll(async () => {
    process.env.FRONTEND_ORIGIN ??= "http://localhost:5173";
    process.env.USE_CHECKOUT ??= "false";
    process.env.SMTP_HOST ??= "mailhog";
    process.env.SMTP_PORT ??= "1025";
    process.env.SMTP_USER ??= "test";
    process.env.SMTP_PASS ??= "test";

    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
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
        url: "/api/v1/products",
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
        url: "/api/v1/products",
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
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(stripe.products.list).toHaveBeenCalledWith({
        active: true,
        limit: 100,
        expand: ["data.default_price"],
      });
    });

    it("returns defaultPrice as null when default_price is a string ID (not expanded)", async () => {
      const token = makeAdminToken();
      const mockProducts = [
        { id: "prod_1", name: "Pro Plan", description: null, default_price: "price_string_id" },
      ];

      (stripe.products.list as any).mockResolvedValueOnce({ data: mockProducts });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].defaultPrice).toBeNull();
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/products",
      });

      expect(response.statusCode).toBe(401);
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
        payload: { name: "New Plan", amountCents: 4900 },
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
        payload: { name: "Described Plan", amountCents: 999, description: "A description" },
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
        payload: { name: "No Desc", amountCents: 500 },
      });

      const callArgs = (stripe.products.create as any).mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("description");
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
        payload: { name: "Price Check", amountCents: 1500, currency: "eur" },
      });

      expect(stripe.prices.create).toHaveBeenCalledWith({
        product: "prod_price_check",
        unit_amount: 1500,
        currency: "eur",
      });
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
        payload: { name: "USD Plan", amountCents: 2000 },
      });

      expect(stripe.prices.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "usd" })
      );
    });

    it("returns 400 when name is missing", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { amountCents: 1000 },
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
        payload: { name: "   ", amountCents: 1000 },
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
        payload: { name: "Plan", amountCents: 0 },
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
        payload: { name: "Plan", amountCents: 9.99 },
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
        payload: { name: "Plan", amountCents: -100 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/amountCents/i);
    });

    it("returns 401 when no JWT provided", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { "content-type": "application/json" },
        payload: { name: "Plan", amountCents: 1000 },
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
