import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_JWT_SECRET = "test_jwt_secret_minimum_32_characters_long";

// ─── Drizzle-orm stub ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (field: unknown, value: unknown) => ({ field, value }),
  and: (...conditions: any[]) => ({ all: conditions }),
  isNull: (field: unknown) => ({ isNull: true, field }),
}));

// ─── In-memory data store ─────────────────────────────────────────────────────
const dataStore = {
  clients: new Map<string, any>(),
  invoices: new Map<string, any>(),
  subscriptions: new Map<string, any>(),
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

function rowsByTable(table: any): any[] {
  if (isTable(table, "clients")) return Array.from(dataStore.clients.values());
  if (isTable(table, "invoices")) return Array.from(dataStore.invoices.values());
  if (isTable(table, "subscriptions")) return Array.from(dataStore.subscriptions.values());
  return [];
}

function filterByExpr(rows: any[], expr: any): any[] {
  if (!expr) return rows;
  if (expr.value !== undefined && expr.field !== undefined) {
    const colName = resolveColumnName(expr.field);
    if (!colName) return rows;
    return rows.filter((r) => {
      // Try both snake_case and camelCase property access
      const camel = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return r[colName] === expr.value || r[camel] === expr.value;
    });
  }
  return rows;
}

// Attach clientName from the clients store for join-like queries
function enrichWithClientName(row: any): any {
  if (row.clientId) {
    const client = dataStore.clients.get(row.clientId);
    if (client) return { ...row, clientName: client.name };
  }
  return row;
}

const dbMock = {
  select: vi.fn((_fields?: any) => ({
    from: (table: any) => {
      const baseRows = rowsByTable(table);
      const basePromise = Promise.resolve(baseRows);

      return {
        leftJoin: (_joinTable: any, _on: any) => ({
          where: (expr: any) => {
            const filtered = filterByExpr(baseRows, expr).map(enrichWithClientName);
            return chainable(Promise.resolve(filtered));
          },
          then: basePromise.then.bind(basePromise),
          catch: basePromise.catch.bind(basePromise),
          finally: basePromise.finally.bind(basePromise),
        }),
        where: (expr: any) => {
          const filtered = filterByExpr(baseRows, expr);
          return chainable(Promise.resolve(filtered));
        },
        then: basePromise.then.bind(basePromise),
        catch: basePromise.catch.bind(basePromise),
        finally: basePromise.finally.bind(basePromise),
      };
    },
  })),

  insert: vi.fn((table: any) => ({
    values: (payload: any) => {
      if (isTable(table, "clients")) {
        dataStore.clients.set(payload.id, { ...payload });
      }
      if (isTable(table, "invoices")) {
        dataStore.invoices.set(payload.id, { ...payload });
      }
      if (isTable(table, "subscriptions")) {
        dataStore.subscriptions.set(payload.id, { ...payload });
      }
      return { onConflictDoNothing: async () => {} };
    },
  })),

  update: vi.fn((table: any) => ({
    set: (values: any) => ({
      where: (expr: any) => {
        const rows = rowsByTable(table);
        const targets = filterByExpr(rows, expr);
        for (const row of targets) {
          Object.assign(row, values);
        }
        const updatedRows = [...targets];
        const result = Promise.resolve(updatedRows);
        return {
          returning: () => result,
          then: result.then.bind(result),
          catch: result.catch.bind(result),
          finally: result.finally.bind(result),
        };
      },
    }),
  })),
};

vi.mock("../db/client", () => ({ db: dbMock }));

// ─── Nodemailer stub (captures emails) ───────────────────────────────────────
const sentEmails: Array<{ to: string; subject: string }> = [];

vi.mock("nodemailer", () => {
  const sendMail = vi.fn(async (opts: any) => {
    sentEmails.push({ to: String(opts.to ?? ""), subject: String(opts.subject ?? "") });
    return {};
  });
  const createTransport = () => ({ sendMail });
  return { __esModule: true, default: { createTransport }, createTransport };
});

// ─── Stripe stub ─────────────────────────────────────────────────────────────
vi.mock("../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    webhooks: {},
  },
}));

function makeAdminJwt() {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

describe("Invoice pay flow (one-time invoice)", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;
  const TEST_CLIENT_ID = "test-client-001";
  let capturedToken: string;

  beforeEach(async () => {
    dataStore.clients.clear();
    dataStore.invoices.clear();
    dataStore.subscriptions.clear();
    sentEmails.length = 0;

    dataStore.clients.set(TEST_CLIENT_ID, {
      id: TEST_CLIENT_ID,
      name: "Test Client Co",
      email: "billing@testclient.test",
      status: "active",
      apiKeyHash: null,
      apiKeyLookup: null,
      stripeAccountId: null,
    });

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

    const { buildServer } = await import("../app");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("creates an invoice, fetches it, pays it, and guards against double-pay", async () => {
    const adminToken = makeAdminJwt();

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId: TEST_CLIENT_ID,
        amountCents: 9900,
        description: "Website hosting — March 2026",
      }),
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.status).toBe("pending");
    expect(created.amountCents).toBe(9900);
    expect(created.description).toBe("Website hosting — March 2026");
    expect(typeof created.paymentToken).toBe("string");
    expect(created.paymentToken.length).toBeGreaterThan(10);

    capturedToken = created.paymentToken;

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/invoices/pay/${capturedToken}`,
    });

    expect(getRes.statusCode).toBe(200);
    const fetched = JSON.parse(getRes.body);
    expect(fetched.amountCents).toBe(9900);
    expect(fetched.description).toBe("Website hosting — March 2026");
    expect(fetched.status).toBe("pending");

    const payRes = await app.inject({
      method: "POST",
      url: `/api/v1/invoices/pay/${capturedToken}`,
    });

    expect(payRes.statusCode).toBe(200);
    const payBody = JSON.parse(payRes.body);
    expect(payBody.invoice.status).toBe("paid");
    expect(payBody.payment.mock).toBe(true);
    expect(payBody.payment.status).toBe("succeeded");
    expect(payBody.payment.amount).toBe(9900);
    expect(payBody.payment.id).toMatch(/^mock_pi_/);

    const revisitRes = await app.inject({
      method: "POST",
      url: `/api/v1/invoices/pay/${capturedToken}`,
    });

    expect(revisitRes.statusCode).toBe(409);

    const getAgainRes = await app.inject({
      method: "GET",
      url: `/api/v1/invoices/pay/${capturedToken}`,
    });
    expect(getAgainRes.statusCode).toBe(200);
    expect(JSON.parse(getAgainRes.body).status).toBe("paid");
  });

  it("returns 404 for unknown token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/invoices/pay/unknown-token-that-does-not-exist",
    });
    expect(res.statusCode).toBe(404);
  });
});

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

function seedBaseClient(id = "client-001") {
  dataStore.clients.set(id, {
    id,
    name: "Test Corp",
    email: "billing@testcorp.test",
    status: "active",
    apiKeyHash: null,
    apiKeyLookup: null,
    stripeAccountId: null,
  });
}

describe("POST /invoices — input validation", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    dataStore.invoices.clear();
    dataStore.subscriptions.clear();
    sentEmails.length = 0;
    seedBaseClient();
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
    { label: "string", value: "fifty" },
  ])("returns 400 for invalid amountCents ($label)", async ({ value }) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-001",
        amountCents: value,
        description: "Service fee",
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
      body: JSON.stringify({
        clientId: "ghost-client",
        amountCents: 5000,
        description: "Service fee",
      }),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/Client not found/);
  });

  it("accepts an optional dueDate and sends an email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client-001",
        amountCents: 15000,
        description: "Consulting Q2",
        dueDate: "2026-06-30T00:00:00.000Z",
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.dueDate).not.toBeNull();
    expect(body.description).toBe("Consulting Q2");
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe("billing@testcorp.test");
  });
});

describe("GET /invoices — list and filters", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    dataStore.invoices.clear();
    dataStore.subscriptions.clear();
    sentEmails.length = 0;

    const now = new Date();
    dataStore.clients.set("client-A", {
      id: "client-A",
      name: "Alpha Inc",
      email: "a@test.com",
      status: "active",
      apiKeyHash: null,
      apiKeyLookup: null,
      stripeAccountId: null,
    });
    dataStore.clients.set("client-B", {
      id: "client-B",
      name: "Beta LLC",
      email: "b@test.com",
      status: "active",
      apiKeyHash: null,
      apiKeyLookup: null,
      stripeAccountId: null,
    });

    dataStore.invoices.set("inv-1", {
      id: "inv-1",
      clientId: "client-A",
      status: "pending",
      amountCents: 1000,
      description: "Alpha pending",
      paymentToken: "tok-a1",
      subscriptionId: null,
      dueDate: null,
      paidAt: null,
      mockPaymentId: null,
      createdAt: now,
      updatedAt: now,
    });
    dataStore.invoices.set("inv-2", {
      id: "inv-2",
      clientId: "client-B",
      status: "paid",
      amountCents: 2000,
      description: "Beta paid",
      paymentToken: "tok-b2",
      subscriptionId: null,
      dueDate: null,
      paidAt: now,
      mockPaymentId: "mock_pi_abc",
      createdAt: now,
      updatedAt: now,
    });
    dataStore.invoices.set("inv-3", {
      id: "inv-3",
      clientId: "client-A",
      status: "cancelled",
      amountCents: 3000,
      description: "Alpha cancelled",
      paymentToken: "tok-a3",
      subscriptionId: null,
      dueDate: null,
      paidAt: null,
      mockPaymentId: null,
      createdAt: now,
      updatedAt: now,
    });

    setTestEnv();
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

  it("returns all invoices with no filter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/invoices",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(3);
  });

  it("filters by clientId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/invoices?clientId=client-A",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body.every((inv: any) => inv.clientId === "client-A")).toBe(true);
  });

  it("filters by status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/invoices?status=paid",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe("paid");
    expect(body[0].clientId).toBe("client-B");
  });

  it("returns empty array when filters match nothing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/invoices?status=pending&clientId=client-B",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(0);
  });
});

describe("POST /invoices/pay/:token — edge cases", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    dataStore.invoices.clear();
    dataStore.subscriptions.clear();
    sentEmails.length = 0;

    const now = new Date();
    seedBaseClient();
    dataStore.invoices.set("inv-cancelled", {
      id: "inv-cancelled",
      clientId: "client-001",
      status: "cancelled",
      amountCents: 5000,
      description: "Cancelled invoice",
      paymentToken: "token-cancelled",
      subscriptionId: null,
      dueDate: null,
      paidAt: null,
      mockPaymentId: null,
      createdAt: now,
      updatedAt: now,
    });

    setTestEnv();
    const { buildServer } = await import("../app");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("returns 404 for an unknown payment token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices/pay/completely-unknown-token",
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/Invoice not found/);
  });

  it("returns 422 when the invoice has been cancelled", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invoices/pay/token-cancelled",
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/cancelled/);
  });

  it("returns 409 when a concurrent request beats the atomic update (race condition)", async () => {
    const now = new Date();
    dataStore.invoices.set("inv-race", {
      id: "inv-race",
      clientId: "client-001",
      status: "pending",
      amountCents: 5000,
      description: "Race condition invoice",
      paymentToken: "tok-race",
      subscriptionId: null,
      dueDate: null,
      paidAt: null,
      mockPaymentId: null,
      createdAt: now,
      updatedAt: now,
    });

    dbMock.update.mockImplementationOnce((_table: any) => ({
      set: (_values: any) => ({
        where: (_expr: any) => {
          const empty = Promise.resolve([]);
          return {
            returning: () => empty,
            then: empty.then.bind(empty),
            catch: empty.catch.bind(empty),
            finally: empty.finally.bind(empty),
          };
        },
      }),
    }));

    const res = await app.inject({ method: "POST", url: "/api/v1/invoices/pay/tok-race" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/already been paid/);
  });
});

describe("PATCH /invoices/:id — cancel", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    dataStore.invoices.clear();
    dataStore.subscriptions.clear();
    sentEmails.length = 0;

    const now = new Date();
    seedBaseClient();
    dataStore.invoices.set("inv-pending", {
      id: "inv-pending",
      clientId: "client-001",
      status: "pending",
      amountCents: 7500,
      description: "Pending invoice",
      paymentToken: "tok-pending",
      subscriptionId: null,
      dueDate: null,
      paidAt: null,
      mockPaymentId: null,
      createdAt: now,
      updatedAt: now,
    });
    dataStore.invoices.set("inv-paid", {
      id: "inv-paid",
      clientId: "client-001",
      status: "paid",
      amountCents: 7500,
      description: "Paid invoice",
      paymentToken: "tok-paid",
      subscriptionId: null,
      dueDate: null,
      paidAt: now,
      mockPaymentId: "mock_pi_xyz",
      createdAt: now,
      updatedAt: now,
    });

    setTestEnv();
    const { buildServer } = await import("../app");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("returns 401 without admin JWT", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/invoices/inv-pending" });
    expect(res.statusCode).toBe(401);
  });

  it("cancels a pending invoice", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/inv-pending",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe("inv-pending");
    expect(body.status).toBe("cancelled");
    expect(dataStore.invoices.get("inv-pending")?.status).toBe("cancelled");
  });

  it("returns 404 when invoice does not exist", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/no-such-invoice",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/Invoice not found/);
  });

  it("returns 422 when trying to cancel a non-pending invoice", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/invoices/inv-paid",
      headers: { Authorization: `Bearer ${makeAdminJwt()}` },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/pending/);
  });
});

describe("triggerAutoAdvance — subscription billing cycle", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;

  beforeEach(async () => {
    dataStore.clients.clear();
    dataStore.invoices.clear();
    dataStore.subscriptions.clear();
    sentEmails.length = 0;
    seedBaseClient();
    setTestEnv();
    const { buildServer } = await import("../app");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.resetModules();
  });

  it("advances billing date by one month and creates the next invoice (monthly)", async () => {
    const billingDate = new Date("2026-03-15T12:00:00.000Z");
    const subId = "sub-monthly-001";

    dataStore.subscriptions.set(subId, {
      id: subId,
      clientId: "client-001",
      status: "active",
      amountCents: 9900,
      description: "Monthly retainer",
      interval: "monthly",
      paymentsMade: 0,
      totalPayments: null,
      nextBillingDate: billingDate,
      createdAt: billingDate,
      updatedAt: billingDate,
    });
    dataStore.invoices.set("inv-sub-1", {
      id: "inv-sub-1",
      clientId: "client-001",
      subscriptionId: subId,
      status: "pending",
      amountCents: 9900,
      description: "Monthly retainer",
      paymentToken: "tok-sub-month-1",
      dueDate: billingDate,
      paidAt: null,
      mockPaymentId: null,
      createdAt: billingDate,
      updatedAt: billingDate,
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/invoices/pay/tok-sub-month-1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).invoice.status).toBe("paid");

    const sub = dataStore.subscriptions.get(subId);
    expect(sub?.paymentsMade).toBe(1);

    // next billing date should be ~1 month later
    const diffDays =
      (new Date(sub?.nextBillingDate).getTime() - billingDate.getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThanOrEqual(28);
    expect(diffDays).toBeLessThanOrEqual(32);

    // a new invoice should have been queued for the next cycle
    expect(dataStore.invoices.size).toBe(2);
    const nextInv = Array.from(dataStore.invoices.values()).find((i) => i.id !== "inv-sub-1");
    expect(nextInv?.subscriptionId).toBe(subId);
    expect(nextInv?.status).toBe("pending");
    expect(nextInv?.amountCents).toBe(9900);
  });

  it("advances billing date by one quarter (quarterly interval)", async () => {
    const billingDate = new Date("2026-01-15T12:00:00.000Z");
    const subId = "sub-quarterly-001";

    dataStore.subscriptions.set(subId, {
      id: subId,
      clientId: "client-001",
      status: "active",
      amountCents: 29700,
      description: "Quarterly plan",
      interval: "quarterly",
      paymentsMade: 0,
      totalPayments: null,
      nextBillingDate: billingDate,
      createdAt: billingDate,
      updatedAt: billingDate,
    });
    dataStore.invoices.set("inv-q1", {
      id: "inv-q1",
      clientId: "client-001",
      subscriptionId: subId,
      status: "pending",
      amountCents: 29700,
      description: "Quarterly plan",
      paymentToken: "tok-quarterly-1",
      dueDate: billingDate,
      paidAt: null,
      mockPaymentId: null,
      createdAt: billingDate,
      updatedAt: billingDate,
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/invoices/pay/tok-quarterly-1" });
    expect(res.statusCode).toBe(200);

    const sub = dataStore.subscriptions.get(subId);
    expect(sub?.paymentsMade).toBe(1);

    const diffDays =
      (new Date(sub?.nextBillingDate).getTime() - billingDate.getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThanOrEqual(88);
    expect(diffDays).toBeLessThanOrEqual(93);
  });

  it("advances billing date by one year (yearly interval)", async () => {
    const billingDate = new Date("2026-03-15T12:00:00.000Z");
    const subId = "sub-yearly-001";

    dataStore.subscriptions.set(subId, {
      id: subId,
      clientId: "client-001",
      status: "active",
      amountCents: 99000,
      description: "Annual plan",
      interval: "yearly",
      paymentsMade: 0,
      totalPayments: null,
      nextBillingDate: billingDate,
      createdAt: billingDate,
      updatedAt: billingDate,
    });
    dataStore.invoices.set("inv-yr1", {
      id: "inv-yr1",
      clientId: "client-001",
      subscriptionId: subId,
      status: "pending",
      amountCents: 99000,
      description: "Annual plan",
      paymentToken: "tok-yearly-1",
      dueDate: billingDate,
      paidAt: null,
      mockPaymentId: null,
      createdAt: billingDate,
      updatedAt: billingDate,
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/invoices/pay/tok-yearly-1" });
    expect(res.statusCode).toBe(200);

    const sub = dataStore.subscriptions.get(subId);
    expect(sub?.paymentsMade).toBe(1);

    const diffDays =
      (new Date(sub?.nextBillingDate).getTime() - billingDate.getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThanOrEqual(365);
    expect(diffDays).toBeLessThanOrEqual(366);
  });

  it("marks subscription completed when final payment is made", async () => {
    const billingDate = new Date("2026-03-15T12:00:00.000Z");
    const subId = "sub-final-001";

    dataStore.subscriptions.set(subId, {
      id: subId,
      clientId: "client-001",
      status: "active",
      amountCents: 20000,
      description: "3-month project",
      interval: "monthly",
      paymentsMade: 2,
      totalPayments: 3,
      nextBillingDate: billingDate,
      createdAt: billingDate,
      updatedAt: billingDate,
    });
    dataStore.invoices.set("inv-final", {
      id: "inv-final",
      clientId: "client-001",
      subscriptionId: subId,
      status: "pending",
      amountCents: 20000,
      description: "3-month project",
      paymentToken: "tok-final-pay",
      dueDate: billingDate,
      paidAt: null,
      mockPaymentId: null,
      createdAt: billingDate,
      updatedAt: billingDate,
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/invoices/pay/tok-final-pay" });
    expect(res.statusCode).toBe(200);

    const sub = dataStore.subscriptions.get(subId);
    expect(sub?.status).toBe("completed");
    expect(sub?.paymentsMade).toBe(3);
    // no new invoice created
    expect(dataStore.invoices.size).toBe(1);
  });

  it("does not advance a paused subscription", async () => {
    const billingDate = new Date("2026-03-15T12:00:00.000Z");
    const subId = "sub-paused-001";

    dataStore.subscriptions.set(subId, {
      id: subId,
      clientId: "client-001",
      status: "paused",
      amountCents: 5000,
      description: "Paused plan",
      interval: "monthly",
      paymentsMade: 1,
      totalPayments: null,
      nextBillingDate: billingDate,
      createdAt: billingDate,
      updatedAt: billingDate,
    });
    dataStore.invoices.set("inv-paused", {
      id: "inv-paused",
      clientId: "client-001",
      subscriptionId: subId,
      status: "pending",
      amountCents: 5000,
      description: "Paused plan",
      paymentToken: "tok-paused",
      dueDate: billingDate,
      paidAt: null,
      mockPaymentId: null,
      createdAt: billingDate,
      updatedAt: billingDate,
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/invoices/pay/tok-paused" });
    // payment itself still succeeds
    expect(res.statusCode).toBe(200);

    // subscription state unchanged
    const sub = dataStore.subscriptions.get(subId);
    expect(sub?.status).toBe("paused");
    expect(sub?.paymentsMade).toBe(1);
    // no new invoice created
    expect(dataStore.invoices.size).toBe(1);
  });
});
