import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAdminToken } from "./helpers/auth";
import { setTestEnv } from "./helpers/env";
import { createInvoicesDbMock, createNodemailerMock } from "./helpers/mock-factories";
import { seedClient } from "./helpers/seed";
import { makeStripeInvoice } from "./helpers/stripe-factories";

// ─── Drizzle-orm stub ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (field: unknown, value: unknown) => ({ field, value }),
  and: (...conditions: any[]) => ({ all: conditions }),
  inArray: (field: unknown, values: unknown[]) => ({ field, values }),
  isNull: (field: unknown) => ({ isNull: true, field }),
}));

// ─── In-memory data store ─────────────────────────────────────────────────────
const dataStore = {
  clients: new Map<string, any>(),
};

const dbMock = createInvoicesDbMock(dataStore);

vi.mock("../db/client", () => ({ db: dbMock }));

// ─── Nodemailer stub ──────────────────────────────────────────────────────────
const sentEmails: Array<{ to: string; subject: string }> = [];
const nodemailerMock = createNodemailerMock(sentEmails, (opts: any) => ({
  to: String(opts.to ?? ""),
  subject: String(opts.subject ?? ""),
}));
vi.mock("nodemailer", () => nodemailerMock);

// ─── Stripe stub ──────────────────────────────────────────────────────────────
const stripeMock = {
  accounts: { create: vi.fn() },
  accountLinks: { create: vi.fn() },
  paymentIntents: { create: vi.fn(), list: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  webhooks: {},
  customers: {
    create: vi.fn().mockResolvedValue({ id: "cus_test_001" }),
  },
  invoiceItems: {
    create: vi.fn().mockResolvedValue({ id: "ii_test_001" }),
  },
  invoices: {
    create: vi.fn().mockResolvedValue(makeStripeInvoice({ status: "draft" })),
    finalizeInvoice: vi.fn().mockResolvedValue(makeStripeInvoice()),
    retrieve: vi.fn().mockResolvedValue(makeStripeInvoice()),
    list: vi.fn().mockResolvedValue({ data: [] }),
    voidInvoice: vi.fn().mockResolvedValue(makeStripeInvoice({ status: "void" })),
    del: vi.fn().mockResolvedValue({ id: "in_test_001", deleted: true }),
  },
  taxRates: {
    retrieve: vi.fn().mockResolvedValue({ id: "txr_default" }),
  },
};

vi.mock("../lib/stripe", () => ({ stripe: stripeMock }));

const workspace = "client_portal";

describe("POST /invoices — input validation", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    sentEmails.length = 0;
    vi.clearAllMocks();
    seedClient(dataStore, {
      id: "client-001",
      name: "Test Corp",
      email: "billing@testcorp.test",
      workspace,
      apiKeyHash: null,
      stripeCustomerId: null,
    });
    setTestEnv();
    const { buildServer } = await import("../app");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("returns 400 when clientId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, amountCents: 5000, description: "Service fee" }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/clientId/);
  });

  it.each([
    { label: "zero", value: 0 },
    { label: "negative", value: -100 },
    { label: "float", value: 9.99 },
  ])("returns 400 for invalid amountCents ($label)", async ({ value }) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-001",
        workspace,
        amountCents: value,
        description: "fee",
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/amountCents/);
  });

  it.each([
    { label: "empty string", value: "" },
    { label: "whitespace only", value: "   " },
  ])("returns 400 for invalid description ($label)", async ({ value }) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-001",
        workspace,
        amountCents: 5000,
        description: value,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/description/);
  });

  it("returns 404 when client does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "ghost", workspace, amountCents: 5000, description: "fee" }),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/Client not found/);
  });

  it("returns 400 when taxRateId is invalid", async () => {
    stripeMock.taxRates.retrieve.mockRejectedValueOnce(new Error("No such tax rate"));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-001",
        workspace,
        amountCents: 5000,
        description: "Service fee",
        taxRateId: "txr_bad",
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid taxRateId/);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it("returns 401 without admin JWT", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/invoices" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /invoices — Stripe customer creation", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    sentEmails.length = 0;
    vi.clearAllMocks();
    setTestEnv();
    const { buildServer } = await import("../app");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("creates a Stripe customer on first invoice and returns 201 with hostedUrl", async () => {
    seedClient(dataStore, {
      id: "client-new",
      name: "Test Corp",
      email: "billing@testcorp.test",
      workspace,
      stripeCustomerId: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-new",
        workspace,
        amountCents: 9900,
        description: "March hosting",
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("open");
    expect(body.amountCents).toBe(9900);
    expect(body.hostedUrl).toBe("https://invoice.stripe.com/i/test");
    expect(stripeMock.customers.create).toHaveBeenCalledOnce();
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledTimes(2);
    expect(stripeMock.invoices.finalizeInvoice).toHaveBeenCalledOnce();
  });

  it("reuses existing stripeCustomerId without creating a new customer", async () => {
    seedClient(dataStore, {
      id: "client-existing",
      name: "Test Corp",
      email: "billing@testcorp.test",
      workspace,
      stripeCustomerId: "cus_already_exists",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-existing",
        workspace,
        amountCents: 5000,
        description: "Consulting",
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_already_exists" })
    );
  });

  it("sends an email after creating the invoice", async () => {
    seedClient(dataStore, {
      id: "client-email",
      name: "Test Corp",
      email: "billing@testcorp.test",
      workspace,
      stripeCustomerId: null,
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-email",
        workspace,
        amountCents: 7500,
        description: "Dev work",
      }),
    });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe("billing@testcorp.test");
  });

  it("applies default tax rate to invoice when taxRateId is provided", async () => {
    seedClient(dataStore, {
      id: "client-taxed",
      name: "Taxed Corp",
      email: "taxed@testcorp.test",
      workspace,
      stripeCustomerId: "cus_taxed_001",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-taxed",
        workspace,
        amountCents: 10000,
        description: "Taxed service",
        taxRateId: "txr_123",
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(stripeMock.taxRates.retrieve).toHaveBeenCalledWith("txr_123");
    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        default_tax_rates: ["txr_123"],
        metadata: expect.objectContaining({ taxRateId: "txr_123" }),
      })
    );
  });
});

describe("GET /invoices — list and filters", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    sentEmails.length = 0;
    vi.clearAllMocks();
    setTestEnv();
    dataStore.clients.set("client-A", {
      id: "client-A",
      name: "Alpha Inc",
      email: "a@test.com",
      workspace,
      status: "active",
      stripeCustomerId: "cus_alpha",
    });
    dataStore.clients.set("client-B", {
      id: "client-B",
      name: "Beta LLC",
      email: "b@test.com",
      workspace,
      status: "active",
      stripeCustomerId: null,
    });
    const { buildServer } = await import("../app");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("returns 401 without admin JWT", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/invoices" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty array when client has no stripeCustomerId", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/invoices?workspace=${workspace}&clientId=client-B`,
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
    expect(stripeMock.invoices.list).not.toHaveBeenCalled();
  });

  it("calls Stripe list with customer param when clientId provided", async () => {
    stripeMock.invoices.list.mockResolvedValueOnce({
      data: [makeStripeInvoice({ metadata: { clientId: "client-A" } })],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/invoices?workspace=${workspace}&clientId=client-A`,
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].clientName).toBe("Alpha Inc");
    expect(stripeMock.invoices.list).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_alpha" })
    );
  });

  it("lists all invoices without filter", async () => {
    stripeMock.invoices.list.mockResolvedValueOnce({
      data: [
        makeStripeInvoice({ id: "in_1", metadata: { clientId: "client-A" } }),
        makeStripeInvoice({ id: "in_2", metadata: { clientId: "client-B" } }),
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/invoices?workspace=${workspace}`,
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(2);
  });
});

describe("PATCH /invoices/:id", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    sentEmails.length = 0;
    vi.clearAllMocks();
    setTestEnv();
    const { buildServer } = await import("../app");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("returns 401 without admin JWT", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/invoices/in_test" });
    expect(res.statusCode).toBe(401);
  });

  it("voids an open invoice", async () => {
    stripeMock.invoices.retrieve.mockResolvedValueOnce(makeStripeInvoice({ status: "open" }));
    stripeMock.invoices.voidInvoice.mockResolvedValueOnce(makeStripeInvoice({ status: "void" }));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/in_open_001",
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("void");
    expect(stripeMock.invoices.voidInvoice).toHaveBeenCalledWith("in_open_001");
  });

  it("deletes a draft invoice", async () => {
    stripeMock.invoices.retrieve.mockResolvedValueOnce(makeStripeInvoice({ status: "draft" }));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/in_draft_001",
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(stripeMock.invoices.del).toHaveBeenCalledWith("in_draft_001");
  });

  it("returns 422 for a paid invoice", async () => {
    stripeMock.invoices.retrieve.mockResolvedValueOnce(makeStripeInvoice({ status: "paid" }));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/in_paid_001",
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });

    expect(res.statusCode).toBe(422);
  });

  it("returns 404 when Stripe throws not-found", async () => {
    stripeMock.invoices.retrieve.mockRejectedValueOnce(new Error("No such invoice"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/in_ghost",
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
