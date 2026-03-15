import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_JWT_SECRET = "test_jwt_secret_minimum_32_characters_long";

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

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function resolveTableName(table: any): string | undefined {
  if (!table) return undefined;
  if (typeof table.tableName === "string") return table.tableName;
  const sym = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof sym === "string" ? sym : undefined;
}

function isTable(table: any, name: string): boolean {
  return resolveTableName(table) === name;
}

function resolveColumnName(col: any): string | undefined {
  if (!col) return undefined;
  if (typeof col === "string") return col;
  if (typeof col.name === "string") return col.name;
  if (typeof col.columnName === "string") return col.columnName;
  const sym = (col as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof sym === "string" ? sym : undefined;
}

function chainable(rowsPromise: Promise<any[]>) {
  return {
    limit: (_n: number) => rowsPromise.then((rows) => rows.slice(0, _n)),
    then: rowsPromise.then.bind(rowsPromise),
    catch: rowsPromise.catch.bind(rowsPromise),
    finally: rowsPromise.finally.bind(rowsPromise),
  };
}

function filterByExpr(rows: any[], expr: any): any[] {
  if (!expr) return rows;
  if (expr.value !== undefined && expr.field !== undefined) {
    const colName = resolveColumnName(expr.field);
    if (!colName) return rows;
    return rows.filter((r) => {
      const camel = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return r[colName] === expr.value || r[camel] === expr.value;
    });
  }
  if (expr.values !== undefined && expr.field !== undefined) {
    const colName = resolveColumnName(expr.field);
    if (!colName) return rows;
    return rows.filter((r) => {
      const camel = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return expr.values.includes(r[colName]) || expr.values.includes(r[camel]);
    });
  }
  return rows;
}

const dbMock = {
  select: vi.fn((_fields?: any) => ({
    from: (table: any) => {
      const baseRows = isTable(table, "clients") ? Array.from(dataStore.clients.values()) : [];
      const basePromise = Promise.resolve(baseRows);

      return {
        leftJoin: (_joinTable: any, _on: any) => ({
          where: (expr: any) => chainable(Promise.resolve(filterByExpr(baseRows, expr))),
          then: basePromise.then.bind(basePromise),
        }),
        where: (expr: any) => chainable(Promise.resolve(filterByExpr(baseRows, expr))),
        then: basePromise.then.bind(basePromise),
        catch: basePromise.catch.bind(basePromise),
        finally: basePromise.finally.bind(basePromise),
      };
    },
  })),

  update: vi.fn((table: any) => ({
    set: (values: any) => ({
      where: (expr: any) => {
        const rows = isTable(table, "clients") ? Array.from(dataStore.clients.values()) : [];
        const targets = filterByExpr(rows, expr);
        for (const row of targets) {
          Object.assign(row, values);
        }
        return Promise.resolve(targets);
      },
    }),
  })),
};

vi.mock("../db/client", () => ({ db: dbMock }));

// ─── Nodemailer stub ──────────────────────────────────────────────────────────
const sentEmails: Array<{ to: string; subject: string }> = [];

vi.mock("nodemailer", () => {
  const sendMail = vi.fn(async (opts: any) => {
    sentEmails.push({ to: String(opts.to ?? ""), subject: String(opts.subject ?? "") });
    return {};
  });
  const createTransport = () => ({ sendMail });
  return { __esModule: true, default: { createTransport }, createTransport };
});

// ─── Stripe stub ──────────────────────────────────────────────────────────────
const makeStripeInvoice = (overrides: Record<string, any> = {}) => ({
  id: "in_test_001",
  object: "invoice",
  amount_due: 9900,
  description: "Website hosting",
  due_date: Math.floor(Date.now() / 1000) + 86400 * 30,
  status: "open",
  hosted_invoice_url: "https://invoice.stripe.com/i/test",
  status_transitions: { paid_at: null },
  created: Math.floor(Date.now() / 1000),
  metadata: { clientId: "client-001" },
  ...overrides,
});

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
};

vi.mock("../lib/stripe", () => ({ stripe: stripeMock }));

function makeAdminJwt() {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

function setTestEnv() {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_12345";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.FRONTEND_ORIGIN = "http://localhost:8080";
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "db-mocked-in-tests";
  process.env.SMTP_HOST = "localhost";
  process.env.SMTP_PORT = "1025";
  process.env.SMTP_USER = "test";
  process.env.SMTP_PASS = "test";
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "password";
}

function seedClient(id = "client-001", extra: Record<string, any> = {}) {
  dataStore.clients.set(id, {
    id,
    name: "Test Corp",
    email: "billing@testcorp.test",
    status: "active",
    apiKeyHash: null,
    apiKeyLookup: null,
    stripeAccountId: null,
    stripeCustomerId: null,
    ...extra,
  });
}

describe("POST /invoices — input validation", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    sentEmails.length = 0;
    vi.clearAllMocks();
    seedClient();
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
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 5000, description: "Service fee" }),
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
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "client-001", amountCents: value, description: "fee" }),
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
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "client-001", amountCents: 5000, description: value }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/description/);
  });

  it("returns 404 when client does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "ghost", amountCents: 5000, description: "fee" }),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/Client not found/);
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
    seedClient("client-new", { stripeCustomerId: null });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-new",
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
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledOnce();
    expect(stripeMock.invoices.finalizeInvoice).toHaveBeenCalledOnce();
  });

  it("reuses existing stripeCustomerId without creating a new customer", async () => {
    seedClient("client-existing", { stripeCustomerId: "cus_already_exists" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-existing",
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
    seedClient("client-email", { stripeCustomerId: null });

    await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-email",
        amountCents: 7500,
        description: "Dev work",
      }),
    });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe("billing@testcorp.test");
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
      status: "active",
      stripeCustomerId: "cus_alpha",
    });
    dataStore.clients.set("client-B", {
      id: "client-B",
      name: "Beta LLC",
      email: "b@test.com",
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
      url: "/api/v1/invoices?clientId=client-B",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
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
      url: "/api/v1/invoices?clientId=client-A",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
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
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
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
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
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
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(stripeMock.invoices.del).toHaveBeenCalledWith("in_draft_001");
  });

  it("returns 422 for a paid invoice", async () => {
    stripeMock.invoices.retrieve.mockResolvedValueOnce(makeStripeInvoice({ status: "paid" }));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/in_paid_001",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });

    expect(res.statusCode).toBe(422);
  });

  it("returns 404 when Stripe throws not-found", async () => {
    stripeMock.invoices.retrieve.mockRejectedValueOnce(new Error("No such invoice"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/in_ghost",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
