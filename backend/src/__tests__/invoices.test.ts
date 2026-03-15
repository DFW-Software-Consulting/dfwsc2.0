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

function colIs(col: any, name: string): boolean {
  const resolved = resolveColumnName(col);
  if (!resolved) return false;
  if (resolved === name) return true;
  const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return resolved === camel;
}

// Builds a thenable + limited chain from a rows promise
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
        // leftJoin — just enrich rows with the joined table data
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
        return Promise.resolve();
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

// ─── Tests ───────────────────────────────────────────────────────────────────

function makeAdminJwt() {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

describe("Invoice pay flow (one-time invoice)", () => {
  let app: Awaited<ReturnType<typeof import("../app").buildServer>>;
  const TEST_CLIENT_ID = "test-client-001";
  let capturedToken: string;

  beforeEach(async () => {
    // Reset stores
    dataStore.clients.clear();
    dataStore.invoices.clear();
    dataStore.subscriptions.clear();
    sentEmails.length = 0;

    // Seed test client
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

    // Step 1: Create invoice
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

    // Step 2: Fetch invoice via public pay endpoint
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/invoices/pay/${capturedToken}`,
    });

    expect(getRes.statusCode).toBe(200);
    const fetched = JSON.parse(getRes.body);
    expect(fetched.amountCents).toBe(9900);
    expect(fetched.description).toBe("Website hosting — March 2026");
    expect(fetched.status).toBe("pending");

    // Step 3: Pay the invoice (mock payment)
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

    // Step 4: Re-visit — invoice shows paid (idempotency guard returns 409)
    const revisitRes = await app.inject({
      method: "POST",
      url: `/api/v1/invoices/pay/${capturedToken}`,
    });

    expect(revisitRes.statusCode).toBe(409);

    // Confirm GET still shows paid
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
