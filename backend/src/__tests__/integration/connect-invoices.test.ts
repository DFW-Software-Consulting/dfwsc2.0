import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeConnectInvoicing } = await import("../helpers/fake-stripe-connect-invoicing");
  return { stripe: fakeConnectInvoicing.stripe };
});

import { eq, inArray, sql } from "drizzle-orm";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import {
  clientGroups,
  clients,
  connectCustomers,
  connectInvoices,
  settings,
} from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import {
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
  resetStripeConcurrencyForTests,
} from "../../lib/circuit-breakers";
import {
  INVOICE_ADOPTION_MAX_PAGES,
  INVOICE_DAILY_CREATE_LIMIT,
  INVOICE_MAX_AMOUNT_CENTS,
  INVOICE_MAX_LINES,
} from "../../lib/constants";
import { tokenBuckets } from "../../lib/rate-limit";
import { clearSettingsCache } from "../../lib/stripe-billing";
import {
  ALLOWED_CONNECT_CALLS,
  fakeConnectInvoicing as stripe,
  stripeApiError,
} from "../helpers/fake-stripe-connect-invoicing";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const HOUR = 60 * 60 * 1000;

type Seeded = { id: string; apiKey: string; account: string };

describe("connected-account invoices API (/api/v1/invoices)", () => {
  let app: any;
  const clientIds: string[] = [];
  const groupIds: string[] = [];

  async function seedClient(over: Partial<typeof clients.$inferInsert> = {}): Promise<Seeded> {
    const id = randomUUID();
    const apiKey = `inv_key_${randomUUID().replace(/-/g, "")}`;
    const account = `acct_inv_${id.slice(0, 8)}`;
    await db.insert(clients).values({
      id,
      name: "Invoices Client",
      email: `inv-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: account,
      chargesEnabled: true,
      invoicingEnabled: true,
      // A fixed fee so a test never depends on the global settings defaults.
      processingFeeCents: 250,
      ...over,
    });
    clientIds.push(id);
    return { id, apiKey, account };
  }

  /** A customer known to Postgres and present on the client's Stripe account. */
  async function seedCustomer(c: Seeded, email = "tenant.private@example.com") {
    const stripeCustomerId = `cus_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    stripe.seedCustomer(c.account, { id: stripeCustomerId, email });
    await db.insert(connectCustomers).values({
      id: randomUUID(),
      clientId: c.id,
      connectedAccountId: c.account,
      stripeCustomerId,
      externalRef: null,
      idempotencyKey: sha(stripeCustomerId),
    });
    return stripeCustomerId;
  }

  const body = (customerId: string, over: Record<string, unknown> = {}) => ({
    customerId,
    lines: [{ description: "Rent", unitAmountCents: 100_000, quantity: 1 }],
    ...over,
  });

  const post = (apiKey: string | undefined, payload: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...(key === null ? {} : { "idempotency-key": key }),
      },
      payload: payload as any,
    });
  const get = (apiKey: string | undefined, url: string) =>
    app.inject({ method: "GET", url, headers: apiKey ? { "x-api-key": apiKey } : {} });

  const rowOf = async (clientId: string, key: string) =>
    (
      await db
        .select()
        .from(connectInvoices)
        .where(eq(connectInvoices.id, (await rowIdByKey(clientId, key)) as string))
    )[0];
  async function rowIdByKey(clientId: string, key: string) {
    const rows = await db
      .select({ id: connectInvoices.id, k: connectInvoices.idempotencyKey })
      .from(connectInvoices)
      .where(eq(connectInvoices.clientId, clientId));
    return rows.find((r) => r.k === sha(key))?.id;
  }

  /** Inserts a finished invoice row directly (reads, paging and ceiling tests). */
  async function seedInvoiceRow(
    c: Seeded,
    customerId: string,
    over: Partial<typeof connectInvoices.$inferInsert> = {}
  ) {
    const id = randomUUID();
    await db.insert(connectInvoices).values({
      id,
      clientId: c.id,
      connectedAccountId: c.account,
      stripeCustomerId: customerId,
      idempotencyKey: sha(id),
      requestHash: sha(`req-${id}`),
      creationState: "complete",
      stripeInvoiceId: `in_seed_${id.slice(0, 12)}`,
      status: "draft",
      currency: "usd",
      subtotalCents: 1000,
      feeAmountCents: 0,
      totalCents: 1000,
      amountRemainingCents: 1000,
      lastSyncedAt: new Date(),
      ...over,
    });
    return id;
  }

  beforeAll(async () => {
    process.env.CONNECT_INVOICING = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_1234567890";
    process.env.FRONTEND_ORIGIN = "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    app = await buildServer();
  });

  afterAll(async () => {
    if (clientIds.length > 0) {
      await db.delete(clients).where(inArray(clients.id, clientIds));
    }
    if (groupIds.length > 0) {
      await db.delete(clientGroups).where(inArray(clientGroups.id, groupIds));
    }
    delete process.env.CONNECT_INVOICING;
    if (app) await app.close();
  });

  beforeEach(() => {
    stripe.reset();
    resetCircuitBreakersForTests();
    tokenBuckets.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetStripeConcurrencyForTests();
  });

  describe("registration and auth", () => {
    it("registers no routes unless CONNECT_INVOICING is exactly 'true' (404)", async () => {
      for (const value of [undefined, "false", "TRUE", "1"]) {
        if (value === undefined) delete process.env.CONNECT_INVOICING;
        else process.env.CONNECT_INVOICING = value;
        const off = await buildServer();
        for (const [method, url] of [
          ["POST", "/api/v1/invoices"],
          ["GET", "/api/v1/invoices"],
          ["GET", "/api/v1/invoices/in_1"],
        ]) {
          const res = await off.inject({
            method: method as any,
            url,
            headers: { "x-api-key": "whatever", "idempotency-key": "k" },
            payload: method === "POST" ? { customerId: "cus_1" } : undefined,
          });
          expect(res.statusCode, `${method} ${url} value=${String(value)}`).toBe(404);
        }
        await off.close();
      }
      process.env.CONNECT_INVOICING = "true";
    });

    it("answers 401 without a key or with a bad key", async () => {
      expect((await post(undefined, body("cus_1"))).statusCode).toBe(401);
      expect((await post("nope", body("cus_1"))).statusCode).toBe(401);
      expect((await get(undefined, "/api/v1/invoices")).statusCode).toBe(401);
      expect((await get("nope", "/api/v1/invoices/in_1")).statusCode).toBe(401);
      expect(stripe.calls).toHaveLength(0);
    });

    it("answers 403 INVOICING_NOT_ENABLED when the client flag is off, for reads and writes", async () => {
      const c = await seedClient({ invoicingEnabled: false });
      for (const res of [
        await post(c.apiKey, body("cus_1")),
        await get(c.apiKey, "/api/v1/invoices"),
        await get(c.apiKey, "/api/v1/invoices/in_1"),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe("INVOICING_NOT_ENABLED");
      }
      expect(stripe.calls).toHaveLength(0);
    });

    it("answers 409 ACCOUNT_NOT_CONNECTED on POST when charges are off, while GETs still work", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const created = await post(c.apiKey, body(cust));
      expect(created.statusCode).toBe(201);
      await db.update(clients).set({ chargesEnabled: false }).where(eq(clients.id, c.id));

      const res = await post(c.apiKey, body(cust));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "Client Stripe account is not connected or cannot accept charges.",
        code: "ACCOUNT_NOT_CONNECTED",
      });
      expect((await get(c.apiKey, `/api/v1/invoices/${created.json().id}`)).statusCode).toBe(200);
      expect((await get(c.apiKey, "/api/v1/invoices")).statusCode).toBe(200);
    });

    it("answers 409 on reads when there is no Stripe account at all", async () => {
      const c = await seedClient({ stripeAccountId: null, chargesEnabled: false });
      expect((await post(c.apiKey, body("cus_1"))).statusCode).toBe(409);
      expect((await get(c.apiKey, "/api/v1/invoices")).json().code).toBe("ACCOUNT_NOT_CONNECTED");
    });
  });

  describe("POST /invoices: validation (all before any Stripe call)", () => {
    it("rejects bad requests with 400 and never calls Stripe or spends a write token", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const line = (over: Record<string, unknown> = {}) => ({
        description: "Rent",
        unitAmountCents: 1000,
        quantity: 1,
        ...over,
      });
      const bad: Array<[string, unknown]> = [
        ["no customerId", { lines: [line()] }],
        ["empty customerId", body("  ")],
        ["no lines", { customerId: cust }],
        ["empty lines", body(cust, { lines: [] })],
        [`more than ${INVOICE_MAX_LINES} lines`, body(cust, { lines: Array(51).fill(line()) })],
        ["empty description", body(cust, { lines: [line({ description: " " })] })],
        ["long description", body(cust, { lines: [line({ description: "x".repeat(501) })] })],
        ["zero amount", body(cust, { lines: [line({ unitAmountCents: 0 })] })],
        ["fractional amount", body(cust, { lines: [line({ unitAmountCents: 10.5 })] })],
        [
          "amount above MAX_SAFE_AMOUNT",
          body(cust, { lines: [line({ unitAmountCents: 100_000_000 })] }),
        ],
        ["string amount", body(cust, { lines: [line({ unitAmountCents: "1000" })] })],
        ["zero quantity", body(cust, { lines: [line({ quantity: 0 })] })],
        ["huge quantity", body(cust, { lines: [line({ quantity: 1_000_000 })] })],
        ["fractional quantity", body(cust, { lines: [line({ quantity: 1.5 })] })],
        ["currency eur", body(cust, { currency: "eur" })],
        ["daysUntilDue 0", body(cust, { daysUntilDue: 0 })],
        ["daysUntilDue 366", body(cust, { daysUntilDue: 366 })],
        ["daysUntilDue fractional", body(cust, { daysUntilDue: 1.5 })],
        ["long description field", body(cust, { description: "d".repeat(1501) })],
        ["long footer", body(cust, { footer: "f".repeat(501) })],
        ["reserved metadata key", body(cust, { metadata: { dfwsc_client_id: "x" } })],
        [
          "too many metadata keys",
          body(cust, {
            metadata: Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`k${i}`, "v"])),
          }),
        ],
        ["long metadata value", body(cust, { metadata: { k: "v".repeat(501) } })],
        ["finalize field", body(cust, { finalize: true })],
        ["send field", body(cust, { send: false })],
      ];
      for (const [name, payload] of bad) {
        const res = await post(c.apiKey, payload);
        expect(res.statusCode, name).toBe(400);
      }
      expect((await post(c.apiKey, body(cust), null)).statusCode).toBe(400); // no Idempotency-Key
      expect((await post(c.apiKey, body(cust), "  ")).statusCode).toBe(400);
      expect((await post(c.apiKey, body(cust), "k".repeat(256))).statusCode).toBe(400);

      expect(stripe.calls).toHaveLength(0);
      expect(
        tokenBuckets.get(`ratelimit:bucket:POST:/api/v1/invoices:stripe:${c.account}`)
      ).toBeUndefined();
      expect(
        await db.select().from(connectInvoices).where(eq(connectInvoices.clientId, c.id))
      ).toHaveLength(0);
    });

    it("accepts the documented maxima", async () => {
      const c = await seedClient({ processingFeeCents: 0 });
      const cust = await seedCustomer(c);
      const lines = Array.from({ length: INVOICE_MAX_LINES }, (_, i) => ({
        description: "d".repeat(500),
        unitAmountCents: 1000 + i,
        quantity: i === 0 ? 2 : 1,
      }));
      const res = await post(
        c.apiKey,
        body(cust, {
          lines,
          currency: "USD",
          daysUntilDue: 365,
          description: "d".repeat(1500),
          footer: "f".repeat(500),
          metadata: { k: "v".repeat(500) },
        })
      );
      expect(res.statusCode).toBe(201);
      expect(stripe.callsTo("invoiceItems.create")).toHaveLength(INVOICE_MAX_LINES);
    });

    it("treats unknown fields (waiveFee, amount, totals) as inert", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const res = await post(
        c.apiKey,
        body(cust, { waiveFee: true, amount: 1, totalCents: 1, feeAmountCents: 0 })
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ feeAmountCents: 250, totalCents: 100_250 });
    });
  });

  describe("POST /invoices: fee math and Stripe parameters", () => {
    it("creates a draft with a pass-through Processing Fee line and application_fee_amount", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const res = await post(
        c.apiKey,
        body(cust, {
          lines: [
            { description: "Rent", unitAmountCents: 100_000 },
            { description: "Parking", unitAmountCents: 2500, quantity: 3 },
          ],
          daysUntilDue: 14,
          description: "March",
          footer: "Thanks",
          metadata: { unit: "12" },
        }),
        "full-1"
      );
      expect(res.statusCode).toBe(201);
      const inv = res.json();
      expect(Object.keys(inv).sort()).toEqual(
        [
          "amountPaidCents",
          "amountRemainingCents",
          "createdAt",
          "customerId",
          "currency",
          "dueDate",
          "feeAmountCents",
          "finalizedAt",
          "hostedInvoiceUrl",
          "id",
          "invoicePdf",
          "number",
          "paidAt",
          "status",
          "subtotalCents",
          "totalCents",
          "voidedAt",
        ].sort()
      );
      expect(inv).toMatchObject({
        id: expect.stringMatching(/^in_/),
        status: "draft",
        customerId: cust,
        currency: "usd",
        subtotalCents: 107_500,
        feeAmountCents: 250,
        totalCents: 107_750,
        amountPaidCents: 0,
        amountRemainingCents: 107_750,
        hostedInvoiceUrl: null,
      });

      const [create] = stripe.callsTo("invoices.create");
      expect(create.params).toMatchObject({
        customer: cust,
        collection_method: "send_invoice",
        days_until_due: 14,
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        currency: "usd",
        application_fee_amount: 250,
        description: "March",
        footer: "Thanks",
        metadata: {
          unit: "12",
          dfwsc_client_id: c.id,
          dfwsc_idem_key: sha("full-1"),
        },
      });
      expect(create.options).toEqual({
        stripeAccount: c.account,
        idempotencyKey: `${c.id}:inv:${sha("full-1")}:invoice`,
      });

      const items = stripe.callsTo("invoiceItems.create");
      expect(items.map((i) => i.options?.idempotencyKey)).toEqual([
        `${c.id}:inv:${sha("full-1")}:line:0`,
        `${c.id}:inv:${sha("full-1")}:line:1`,
        `${c.id}:inv:${sha("full-1")}:fee`,
      ]);
      // quantity and unit amount stay visible on the invoice.
      expect(items[0].params).toMatchObject({
        customer: cust,
        invoice: inv.id,
        currency: "usd",
        description: "Rent",
        quantity: 1,
        unit_amount_decimal: "100000",
      });
      expect(items[1].params).toMatchObject({
        description: "Parking",
        quantity: 3,
        unit_amount_decimal: "2500",
      });
      expect(items[1].params?.amount).toBeUndefined();
      expect(items[2].params).toMatchObject({
        description: "Processing Fee",
        quantity: 1,
        unit_amount_decimal: "250",
      });

      const row = await rowOf(c.id, "full-1");
      expect(row).toMatchObject({
        creationState: "complete",
        status: "draft",
        stripeInvoiceId: inv.id,
        subtotalCents: 107_500,
        feeAmountCents: 250,
        totalCents: 107_750,
        claimedAt: null,
        stripeFeeItemId: expect.stringMatching(/^ii_/),
      });
      expect(row.lineItemIds).toHaveLength(2);
      expect(row.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.idempotencyKey).toBe(sha("full-1"));
    });

    it("defaults days until due to the client's terms, else 30, and currency to usd", async () => {
      const a = await seedClient({ defaultPaymentTermsDays: 45 });
      const b = await seedClient();
      const c = await seedClient({ defaultPaymentTermsDays: 9999 }); // out of range: ignored
      for (const client of [a, b, c]) {
        expect((await post(client.apiKey, body(await seedCustomer(client)))).statusCode).toBe(201);
      }
      expect(stripe.callsTo("invoices.create").map((x) => x.params?.days_until_due)).toEqual([
        45, 30, 30,
      ]);
      expect(stripe.callsTo("invoices.create")[0].params?.currency).toBe("usd");
    });

    it("omits the fee item and application_fee_amount when the fee is zero", async () => {
      const c = await seedClient({ processingFeeCents: 0 });
      const cust = await seedCustomer(c);
      const res = await post(c.apiKey, body(cust));
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ feeAmountCents: 0, totalCents: 100_000 });
      expect(stripe.callsTo("invoices.create")[0].params).not.toHaveProperty(
        "application_fee_amount"
      );
      expect(stripe.callsTo("invoiceItems.create")).toHaveLength(1);
    });

    it("uses the client percentage first, rounded", async () => {
      const c = await seedClient({ processingFeePercent: "2.50", processingFeeCents: 999 });
      const res = await post(c.apiKey, body(await seedCustomer(c)));
      expect(res.json()).toMatchObject({ feeAmountCents: 2500, totalCents: 102_500 });
      expect(stripe.callsTo("invoices.create")[0].params?.application_fee_amount).toBe(2500);
    });

    it("uses the client cents when it has no percentage", async () => {
      const c = await seedClient({ processingFeeCents: 175 });
      const res = await post(c.apiKey, body(await seedCustomer(c)));
      expect(res.json().feeAmountCents).toBe(175);
    });

    it("falls back to the group percentage, then the group cents", async () => {
      const make = async (over: Partial<typeof clientGroups.$inferInsert>) => {
        const id = `grp-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        await db.insert(clientGroups).values({
          id,
          name: "Fee Group",
          status: "active",
          workspace: "client_portal",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...over,
        });
        groupIds.push(id);
        return id;
      };
      const pct = await make({ processingFeePercent: "1.00", processingFeeCents: 77 });
      const cents = await make({ processingFeeCents: 77 });
      const a = await seedClient({ processingFeeCents: null, groupId: pct });
      const b = await seedClient({ processingFeeCents: null, groupId: cents });
      expect((await post(a.apiKey, body(await seedCustomer(a)))).json().feeAmountCents).toBe(1000);
      expect((await post(b.apiKey, body(await seedCustomer(b)))).json().feeAmountCents).toBe(77);
    });

    describe("settings and environment defaults", () => {
      const saved: Array<{ key: string; value: string }> = [];
      beforeEach(async () => {
        const rows = await db.select().from(settings);
        saved.length = 0;
        saved.push(...rows.filter((r) => r.key.startsWith("default_fee")));
        await db
          .delete(settings)
          .where(inArray(settings.key, ["default_fee_percent", "default_fee_cents"]));
        delete process.env.DEFAULT_PROCESS_FEE_CENTS;
        clearSettingsCache();
      });
      afterEach(async () => {
        await db
          .delete(settings)
          .where(inArray(settings.key, ["default_fee_percent", "default_fee_cents"]));
        if (saved.length > 0) await db.insert(settings).values(saved);
        delete process.env.DEFAULT_PROCESS_FEE_CENTS;
        clearSettingsCache();
      });

      it("settings percentage, settings cents, then DEFAULT_PROCESS_FEE_CENTS", async () => {
        const c = await seedClient({ processingFeeCents: null });
        const cust = await seedCustomer(c);

        await db.insert(settings).values([
          { key: "default_fee_percent", value: "3" },
          { key: "default_fee_cents", value: "11" },
        ]);
        clearSettingsCache();
        expect((await post(c.apiKey, body(cust))).json().feeAmountCents).toBe(3000);

        await db.delete(settings).where(eq(settings.key, "default_fee_percent"));
        clearSettingsCache();
        expect((await post(c.apiKey, body(cust))).json().feeAmountCents).toBe(11);

        await db.delete(settings).where(eq(settings.key, "default_fee_cents"));
        process.env.DEFAULT_PROCESS_FEE_CENTS = "42";
        clearSettingsCache();
        expect((await post(c.apiKey, body(cust))).json().feeAmountCents).toBe(42);
      });
    });

    it("answers 400 for an invalid configured percentage, before any Stripe call", async () => {
      const c = await seedClient({ processingFeePercent: "150.00" });
      const res = await post(c.apiKey, body(await seedCustomer(c)));
      expect(res.statusCode).toBe(400);
      expect(stripe.calls).toHaveLength(0);
    });
  });

  describe("POST /invoices: caps", () => {
    it(`allows a total of exactly ${INVOICE_MAX_AMOUNT_CENTS} and refuses one cent more`, async () => {
      const c = await seedClient({ processingFeeCents: 0 });
      const cust = await seedCustomer(c);
      const line = (n: number) => ({ lines: [{ description: "x", unitAmountCents: n }] });
      expect((await post(c.apiKey, body(cust, line(2_500_000)))).statusCode).toBe(201);
      stripe.reset();
      const over = await post(c.apiKey, body(cust, line(2_500_001)));
      expect(over.statusCode).toBe(400);
      expect(over.json().code).toBe("INVOICE_AMOUNT_TOO_LARGE");
      expect(stripe.calls).toHaveLength(0);
    });

    it("counts the fee towards the cap", async () => {
      const c = await seedClient({ processingFeeCents: 250 });
      const cust = await seedCustomer(c);
      const line = (n: number) => ({ lines: [{ description: "x", unitAmountCents: n }] });
      const over = await post(c.apiKey, body(cust, line(2_499_751)));
      expect(over.statusCode).toBe(400);
      expect(over.json().code).toBe("INVOICE_AMOUNT_TOO_LARGE");
      expect(stripe.calls).toHaveLength(0);
      expect((await post(c.apiKey, body(cust, line(2_499_750)))).json().totalCents).toBe(2_500_000);
    });

    it("refuses lines whose quantity pushes the sum over the cap or out of safe integers", async () => {
      const c = await seedClient({ processingFeeCents: 0 });
      const cust = await seedCustomer(c);
      for (const lines of [
        [{ description: "x", unitAmountCents: 99_999_999, quantity: 999_999 }],
        [
          { description: "a", unitAmountCents: 2_000_000 },
          { description: "b", unitAmountCents: 600_000 },
        ],
        [{ description: "x", unitAmountCents: 2_500, quantity: 1001 }],
      ]) {
        const res = await post(c.apiKey, body(cust, { lines }));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("INVOICE_AMOUNT_TOO_LARGE");
      }
      expect(stripe.calls).toHaveLength(0);
    });

    it(`refuses the ${INVOICE_DAILY_CREATE_LIMIT + 1}th invoice in a rolling 24 hours (429, Retry-After)`, async () => {
      const c = await seedClient();
      const other = await seedClient();
      const cust = await seedCustomer(c);
      const otherCust = await seedCustomer(other);
      const rows = Array.from({ length: INVOICE_DAILY_CREATE_LIMIT }, (_, i) => {
        const id = randomUUID();
        return {
          id,
          clientId: c.id,
          connectedAccountId: c.account,
          stripeCustomerId: cust,
          idempotencyKey: sha(`bulk-${id}`),
          requestHash: sha("bulk"),
          // Any state counts, including rows still 'reserved'.
          creationState: "reserved" as const,
          currency: "usd",
          subtotalCents: 1,
          feeAmountCents: 0,
          totalCents: 1,
          amountRemainingCents: 1,
          createdAt: new Date(Date.now() - (i === 0 ? 23 * HOUR : 60_000)),
        };
      });
      await db.insert(connectInvoices).values(rows);

      const res = await post(c.apiKey, body(cust));
      expect(res.statusCode).toBe(429);
      expect(res.json().code).toBe("INVOICE_DAILY_LIMIT");
      const retry = Number(res.headers["retry-after"]);
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(HOUR / 1000 + 5); // the oldest row is 23h old
      expect(stripe.calls).toHaveLength(0);

      // A replay of a stored request is not a new creation and is not blocked.
      const keyed = await post(c.apiKey, body(cust), "replay-me");
      expect(keyed.statusCode).toBe(429);

      // Another client has its own count.
      expect((await post(other.apiKey, body(otherCust))).statusCode).toBe(201);

      // Rows older than 24 hours no longer count.
      await db
        .update(connectInvoices)
        .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
        .where(eq(connectInvoices.clientId, c.id));
      expect((await post(c.apiKey, body(cust))).statusCode).toBe(201);
    }, 60_000);

    it("lets a complete replay through even at the daily ceiling", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      expect((await post(c.apiKey, body(cust), "done-key")).statusCode).toBe(201);
      const filler = Array.from({ length: INVOICE_DAILY_CREATE_LIMIT }, () => {
        const id = randomUUID();
        return {
          id,
          clientId: c.id,
          connectedAccountId: c.account,
          stripeCustomerId: cust,
          idempotencyKey: sha(`f-${id}`),
          requestHash: sha("f"),
          creationState: "reserved" as const,
          currency: "usd",
          subtotalCents: 1,
          feeAmountCents: 0,
          totalCents: 1,
          amountRemainingCents: 1,
        };
      });
      await db.insert(connectInvoices).values(filler);
      expect((await post(c.apiKey, body(cust), "done-key")).statusCode).toBe(200);
      expect((await post(c.apiKey, body(cust), "new-key")).statusCode).toBe(429);
    });
  });

  describe("POST /invoices: customer scoping", () => {
    it("answers 404 before any Stripe call for another client's, another account's or an unknown customer", async () => {
      const c = await seedClient();
      const other = await seedClient();
      const mine = await seedCustomer(c);
      const theirs = await seedCustomer(other);
      // A row for this client but recorded against a different connected account.
      const foreignAccount = `cus_acct_${randomUUID().slice(0, 8)}`;
      await db.insert(connectCustomers).values({
        id: randomUUID(),
        clientId: c.id,
        connectedAccountId: "acct_some_other_account",
        stripeCustomerId: foreignAccount,
        externalRef: null,
        idempotencyKey: sha(foreignAccount),
      });
      for (const id of [theirs, foreignAccount, "cus_unknown"]) {
        const res = await post(c.apiKey, body(id));
        expect(res.statusCode, id).toBe(404);
        expect(res.json().code).toBe("NOT_FOUND");
      }
      expect(stripe.calls).toHaveLength(0);
      expect(
        await db.select().from(connectInvoices).where(eq(connectInvoices.clientId, c.id))
      ).toHaveLength(0);
      expect((await post(c.apiKey, body(mine))).statusCode).toBe(201);
    });
  });

  describe("POST /invoices: idempotency", () => {
    it("replays the same key and body with 200 and exactly one Stripe invoice", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const first = await post(c.apiKey, body(cust), "same");
      expect(first.statusCode).toBe(201);
      stripe.calls.length = 0;
      const second = await post(c.apiKey, body(cust), "same");
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(stripe.calls).toHaveLength(0);
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.itemsOn(c.account)).toHaveLength(2);
      // Surrounding whitespace in the key is not part of it.
      expect((await post(c.apiKey, body(cust), "  same  ")).statusCode).toBe(200);
    });

    it("answers 409 IDEMPOTENCY_KEY_REUSED for another body, without Stripe calls", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const cust2 = await seedCustomer(c);
      expect((await post(c.apiKey, body(cust), "k")).statusCode).toBe(201);
      stripe.calls.length = 0;
      const variants = [
        body(cust, { lines: [{ description: "Rent", unitAmountCents: 100_000, quantity: 2 }] }),
        body(cust, { lines: [{ description: "Rent", unitAmountCents: 100_001 }] }),
        body(cust, { lines: [{ description: "Rent!", unitAmountCents: 100_000 }] }),
        body(cust, { description: "memo" }),
        body(cust, { footer: "foot" }),
        body(cust, { daysUntilDue: 5 }),
        body(cust, { metadata: { a: "b" } }),
        body(cust2),
      ];
      for (const v of variants) {
        const res = await post(c.apiKey, v, "k");
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
      }
      expect(stripe.calls).toHaveLength(0);
    });

    it("hashes metadata and default fields canonically (order and spelling of defaults)", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const a = body(cust, { metadata: { a: "1", b: "2" }, currency: "usd" });
      const b = body(cust, { metadata: { b: "2", a: "1" }, description: "" });
      expect((await post(c.apiKey, a, "canon")).statusCode).toBe(201);
      expect((await post(c.apiKey, b, "canon")).statusCode).toBe(200);
      // An explicit daysUntilDue is a different request from an omitted one, even when equal to
      // the client's default today (the default is not part of the hash).
      expect(
        (await post(c.apiKey, body(cust, { ...a, daysUntilDue: 30 }), "canon")).statusCode
      ).toBe(409);
    });

    it("keeps keys separate per client", async () => {
      const a = await seedClient();
      const b = await seedClient();
      const [ca, cb] = [await seedCustomer(a), await seedCustomer(b)];
      const ra = await post(a.apiKey, body(ca), "shared");
      const rb = await post(b.apiKey, body(cb), "shared");
      expect([ra.statusCode, rb.statusCode]).toEqual([201, 201]);
      expect(ra.json().id).not.toBe(rb.json().id);
      expect(stripe.callsTo("invoices.create").map((x) => x.options?.idempotencyKey)).toEqual([
        `${a.id}:inv:${sha("shared")}:invoice`,
        `${b.id}:inv:${sha("shared")}:invoice`,
      ]);
    });

    it("answers 409 IDEMPOTENCY_KEY_IN_USE to a concurrent request with the same key", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      let release!: () => void;
      stripe.invoiceCreateGate = new Promise<void>((r) => {
        release = r;
      });
      const first = post(c.apiKey, body(cust), "race");
      await vi.waitFor(() => expect(stripe.callsTo("invoices.create")).toHaveLength(1));

      const second = await post(c.apiKey, body(cust), "race");
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("IDEMPOTENCY_KEY_IN_USE");
      expect(stripe.callsTo("invoices.create")).toHaveLength(1);

      release();
      const done = await first;
      expect(done.statusCode).toBe(201);
      expect((await post(c.apiKey, body(cust), "race")).statusCode).toBe(200);
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
    });

    it("answers IN_USE for a live claim and takes over an expired one", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      // First attempt dies at the first Stripe step and leaves a reserved row.
      stripe.failNth("invoices.create", 1, stripeApiError(500));
      expect((await post(c.apiKey, body(cust), "lease")).statusCode).toBe(502);
      const id = (await rowIdByKey(c.id, "lease")) as string;

      await db
        .update(connectInvoices)
        .set({ claimedAt: new Date() })
        .where(eq(connectInvoices.id, id));
      const live = await post(c.apiKey, body(cust), "lease");
      expect(live.statusCode).toBe(409);
      expect(live.json().code).toBe("IDEMPOTENCY_KEY_IN_USE");

      await db
        .update(connectInvoices)
        .set({ claimedAt: new Date(Date.now() - 61_000) })
        .where(eq(connectInvoices.id, id));
      const taken = await post(c.apiKey, body(cust), "lease");
      expect(taken.statusCode).toBe(201);
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
    });

    it("does not let a request whose claim was taken over write progress", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      let release!: () => void;
      stripe.invoiceCreateGate = new Promise<void>((r) => {
        release = r;
      });
      const slow = post(c.apiKey, body(cust), "stolen");
      await vi.waitFor(() => expect(stripe.callsTo("invoices.create")).toHaveLength(1));
      // The lease runs out and another request takes the row over.
      const id = (await rowIdByKey(c.id, "stolen")) as string;
      await db
        .update(connectInvoices)
        .set({ claimedAt: new Date(Date.now() - 61_000) })
        .where(eq(connectInvoices.id, id));
      stripe.invoiceCreateGate = null;
      const winner = await post(c.apiKey, body(cust), "stolen");
      expect(winner.statusCode).toBe(201);
      release();
      const loser = await slow;
      // Its progress write finds the row taken over and already complete: same answer, 200.
      expect(loser.statusCode).toBe(200);
      expect(loser.json().id).toBe(winner.json().id);
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.itemsOn(c.account)).toHaveLength(2);
    });

    it("renews the claim on every progress save, so a long create keeps its lease", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const two = body(cust, {
        lines: [
          { description: "Rent", unitAmountCents: 1000 },
          { description: "Parking", unitAmountCents: 500 },
        ],
      });
      const seen: number[] = [];
      stripe.onCall = async (call, nth) => {
        if (call !== "invoiceItems.create") return;
        await new Promise((r) => setTimeout(r, 15));
        const [row] = await db
          .select()
          .from(connectInvoices)
          .where(eq(connectInvoices.clientId, c.id));
        seen[nth] = (row.claimedAt as Date).getTime();
      };
      expect((await post(c.apiKey, two, "renew")).statusCode).toBe(201);
      // line 0 -> line 1 -> fee: each later call sees a later claim than the one before.
      expect(seen[2]).toBeGreaterThan(seen[1]);
      expect(seen[3]).toBeGreaterThan(seen[2]);
    });

    it("answers 200 with the finished invoice when the lease is lost mid-create and another request completes it", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const two = body(cust, {
        lines: [
          { description: "Rent", unitAmountCents: 1000 },
          { description: "Parking", unitAmountCents: 500 },
        ],
      });
      let second: any;
      stripe.onCall = async (call, nth) => {
        if (call !== "invoiceItems.create" || nth !== 2) return;
        stripe.onCall = null;
        const id = (await rowIdByKey(c.id, "lost-lease")) as string;
        await db
          .update(connectInvoices)
          .set({ claimedAt: new Date(Date.now() - 61_000) })
          .where(eq(connectInvoices.id, id));
        second = await post(c.apiKey, two, "lost-lease");
      };
      const first = await post(c.apiKey, two, "lost-lease");
      expect(second.statusCode).toBe(201);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual(second.json());
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.itemsOn(c.account)).toHaveLength(3);
    });

    it("answers IN_USE when the lease is lost to a request that has not finished", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      stripe.onCall = async (call) => {
        if (call !== "invoiceItems.create") return;
        stripe.onCall = null;
        // Another worker took the row over and is still working on it.
        await db
          .update(connectInvoices)
          .set({ claimedAt: new Date(Date.now() + 1000) })
          .where(eq(connectInvoices.clientId, c.id));
      };
      const res = await post(c.apiKey, body(cust), "still-busy");
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("IDEMPOTENCY_KEY_IN_USE");
    });

    it("pins a resume to the row's account: 409 ACCOUNT_CHANGED and no Stripe call when it moved", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      stripe.failNth("invoices.create", 1, stripeApiError(500));
      expect((await post(c.apiKey, body(cust), "moved")).statusCode).toBe(502);
      stripe.calls.length = 0;
      await db
        .update(clients)
        .set({ stripeAccountId: `${c.account}_new` })
        .where(eq(clients.id, c.id));
      const res = await post(c.apiKey, body(cust), "moved");
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ACCOUNT_CHANGED");
      expect(stripe.calls).toHaveLength(0);
      // A finished invoice is still replayed from Postgres whatever account the client has now.
      const done = await seedClient();
      const doneCust = await seedCustomer(done);
      expect((await post(done.apiKey, body(doneCust), "fin")).statusCode).toBe(201);
      await db
        .update(clients)
        .set({ stripeAccountId: `${done.account}_new` })
        .where(eq(clients.id, done.id));
      expect((await post(done.apiKey, body(doneCust), "fin")).statusCode).toBe(200);
    });

    it("re-checks on resume that the row's customer is still recorded for the client and account", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      stripe.failNth("invoices.create", 1, stripeApiError(500));
      expect((await post(c.apiKey, body(cust), "gone")).statusCode).toBe(502);
      stripe.calls.length = 0;
      // The composite FK normally makes this impossible; lift it for the test only.
      await db.execute(
        sql`ALTER TABLE connect_invoices DROP CONSTRAINT connect_invoices_customer_fk`
      );
      try {
        await db.delete(connectCustomers).where(eq(connectCustomers.stripeCustomerId, cust));
        const res = await post(c.apiKey, body(cust), "gone");
        expect(res.statusCode).toBe(404);
        expect(stripe.calls).toHaveLength(0);
      } finally {
        await db.delete(connectInvoices).where(eq(connectInvoices.clientId, c.id));
        await db.execute(sql`ALTER TABLE connect_invoices ADD CONSTRAINT connect_invoices_customer_fk
          FOREIGN KEY (connected_account_id, stripe_customer_id)
          REFERENCES connect_customers (connected_account_id, stripe_customer_id)`);
      }
    });

    it("keeps an identical retry a replay when the client's default terms change", async () => {
      const c = await seedClient({ defaultPaymentTermsDays: 15 });
      const cust = await seedCustomer(c);
      expect((await post(c.apiKey, body(cust), "terms-done")).statusCode).toBe(201);
      await db.update(clients).set({ defaultPaymentTermsDays: 60 }).where(eq(clients.id, c.id));
      const replay = await post(c.apiKey, body(cust), "terms-done");
      expect(replay.statusCode).toBe(200);

      // A create that never reached Stripe picks up the new default on its retry.
      stripe.failNth("invoices.create", 2, stripeApiError(500));
      expect((await post(c.apiKey, body(cust), "terms-retry")).statusCode).toBe(502);
      await db.update(clients).set({ defaultPaymentTermsDays: 20 }).where(eq(clients.id, c.id));
      expect((await post(c.apiKey, body(cust), "terms-retry")).statusCode).toBe(201);
      expect(stripe.callsTo("invoices.create").at(-1)?.params?.days_until_due).toBe(20);
    });

    it("answers 409 (Stripe idempotency mismatch) when Stripe saw the create, the response was lost and the terms changed", async () => {
      const c = await seedClient({ defaultPaymentTermsDays: 15 });
      const cust = await seedCustomer(c);
      stripe.loseResponseNth("invoices.create", 1);
      expect((await post(c.apiKey, body(cust), "edge")).statusCode).toBe(502);
      await db.update(clients).set({ defaultPaymentTermsDays: 45 }).where(eq(clients.id, c.id));
      const res = await post(c.apiKey, body(cust), "edge");
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
    });

    const stepFailures: Array<[string, string, number, "invoice_created" | "reserved"]> = [
      ["the invoice", "invoices.create", 1, "reserved"],
      ["line 0", "invoiceItems.create", 1, "invoice_created"],
      ["line 1", "invoiceItems.create", 2, "invoice_created"],
      ["the fee item", "invoiceItems.create", 3, "invoice_created"],
      ["the final retrieve", "invoices.retrieve", 1, "invoice_created"],
    ];
    it.each(
      stepFailures
    )("resumes after a Stripe failure at %s with no duplicate Stripe objects", async (_name, call, nth, _state) => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const two = body(cust, {
        lines: [
          { description: "Rent", unitAmountCents: 100_000 },
          { description: "Parking", unitAmountCents: 2500, quantity: 2 },
        ],
      });
      stripe.failNth(call, nth, stripeApiError(500));
      const failed = await post(c.apiKey, two, "resume");
      expect(failed.statusCode).toBe(502);

      // The row is hidden from reads until complete, and its claim was given back.
      const partial = await rowOf(c.id, "resume");
      expect(partial.creationState).not.toBe("complete");
      expect(partial.claimedAt).toBeNull();
      expect((await get(c.apiKey, "/api/v1/invoices")).json().data).toEqual([]);

      const retried = await post(c.apiKey, two, "resume");
      expect(retried.statusCode).toBe(201);
      expect(retried.json()).toMatchObject({ totalCents: 105_250, feeAmountCents: 250 });
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.itemsOn(c.account).map((i) => i.description)).toEqual([
        "Rent",
        "Parking",
        "Processing Fee",
      ]);
      // Saved ids are never re-created: only the failed step is sent again.
      if (call !== "invoices.create") {
        expect(stripe.callsTo("invoices.create")).toHaveLength(1);
      }
      if (call === "invoiceItems.create") {
        expect(stripe.callsTo("invoiceItems.create")).toHaveLength(3 + 1);
      }
      const done = await rowOf(c.id, "resume");
      expect(done).toMatchObject({ creationState: "complete", claimedAt: null });
      expect(done.lineItemIds).toHaveLength(2);
    });

    const lostResponses: Array<[string, string, number]> = [
      ["the invoice", "invoices.create", 1],
      ["line 0", "invoiceItems.create", 1],
      ["line 1", "invoiceItems.create", 2],
      ["the fee item", "invoiceItems.create", 3],
    ];
    it.each(
      lostResponses
    )("resumes through key replay when Stripe made %s but the response was lost, with no duplicates", async (_name, call, nth) => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const two = body(cust, {
        lines: [
          { description: "Rent", unitAmountCents: 100_000 },
          { description: "Parking", unitAmountCents: 2500, quantity: 2 },
        ],
      });
      stripe.loseResponseNth(call, nth);
      const failed = await post(c.apiKey, two, "lost");
      expect(failed.statusCode).toBe(502);
      // Stripe has the object even though we never saw it.
      expect(
        stripe.invoicesOn(c.account).length + stripe.itemsOn(c.account).length
      ).toBeGreaterThan(0);

      const retried = await post(c.apiKey, two, "lost");
      expect(retried.statusCode).toBe(201);
      expect(retried.json()).toMatchObject({ totalCents: 105_250, feeAmountCents: 250 });
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.itemsOn(c.account).map((i) => i.description)).toEqual([
        "Rent",
        "Parking",
        "Processing Fee",
      ]);
    });

    it("keeps answering an error while Stripe replays a stored 5xx for the key, then recovers once it expires", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      stripe.failNthStored("invoiceItems.create", 1, stripeApiError(500));
      expect((await post(c.apiKey, body(cust), "pinned")).statusCode).toBe(502);
      // Same key, same parameters, inside 24h: Stripe returns the stored error again. The API
      // surfaces it each time (no loop, nothing created).
      for (let i = 0; i < 2; i++) {
        expect((await post(c.apiKey, body(cust), "pinned")).statusCode).toBe(502);
      }
      expect(stripe.itemsOn(c.account)).toHaveLength(0);
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);

      stripe.expireIdempotencyKeys();
      const ok = await post(c.apiKey, body(cust), "pinned");
      expect(ok.statusCode).toBe(201);
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.itemsOn(c.account)).toHaveLength(2);
    });

    it("refuses a reused Stripe key with other parameters (idempotency error) instead of creating", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      expect((await post(c.apiKey, body(cust), "mismatch-params")).statusCode).toBe(201);
      // Same Stripe key reaching the account with different parameters: the fake, like Stripe,
      // answers an idempotency error.
      await expect(
        (await import("../../lib/stripe")).stripe.invoices.create(
          { customer: cust, currency: "usd", description: "different" },
          {
            stripeAccount: c.account,
            idempotencyKey: `${c.id}:inv:${sha("mismatch-params")}:invoice`,
          }
        )
      ).rejects.toMatchObject({ type: "StripeIdempotencyError" });
    });

    it("keeps the stored fee when the fee setting changes between attempts", async () => {
      const c = await seedClient({ processingFeeCents: 250 });
      const cust = await seedCustomer(c);
      stripe.failNth("invoiceItems.create", 1, stripeApiError(500));
      expect((await post(c.apiKey, body(cust), "fee-drift")).statusCode).toBe(502);
      await db.update(clients).set({ processingFeeCents: 999 }).where(eq(clients.id, c.id));
      const res = await post(c.apiKey, body(cust), "fee-drift");
      expect(res.statusCode).toBe(201);
      expect(res.json().feeAmountCents).toBe(250);
      expect(stripe.itemsOn(c.account).at(-1)).toMatchObject({ amount: 250 });
    });

    it("answers 503 LEDGER_PERSISTENCE_FAILED when Postgres fails after Stripe, and a retry re-adopts", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      vi.spyOn(db, "update").mockImplementationOnce((() => {
        throw new Error("db down");
      }) as never);
      const failed = await post(c.apiKey, body(cust), "pg");
      expect(failed.statusCode).toBe(503);
      expect(failed.json().code).toBe("LEDGER_PERSISTENCE_FAILED");
      vi.restoreAllMocks();
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect((await rowOf(c.id, "pg")).stripeInvoiceId).toBeNull();
      const retried = await post(c.apiKey, body(cust), "pg");
      expect(retried.statusCode).toBe(201);
      // Stripe replayed the same invoice for the same key: one object.
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(retried.json().id).toBe(stripe.invoicesOn(c.account)[0].id);
      expect(stripe.callsTo("invoices.create")).toHaveLength(2);
    });

    it("adopts the invoice by metadata after Stripe's 24h key window, without a second create", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      vi.spyOn(db, "update").mockImplementationOnce((() => {
        throw new Error("db down");
      }) as never);
      expect((await post(c.apiKey, body(cust), "old")).statusCode).toBe(503);
      vi.restoreAllMocks();
      const orphan = stripe.invoicesOn(c.account)[0];
      // Some other customer's invoice on the same account must not be adopted by mistake.
      stripe.expireIdempotencyKeys();
      await db
        .update(connectInvoices)
        .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
        .where(eq(connectInvoices.id, (await rowIdByKey(c.id, "old")) as string));

      const retried = await post(c.apiKey, body(cust), "old");
      expect(retried.statusCode).toBe(201);
      expect(retried.json().id).toBe(orphan.id);
      expect(stripe.callsTo("invoices.create")).toHaveLength(1);
      const [list] = stripe.callsTo("invoices.list");
      expect(list.params).toMatchObject({ customer: cust, limit: 100 });
      expect(list.params?.created.gte).toBeLessThan(Math.floor(Date.now() / 1000) - 24 * 3600);
      expect(list.options).toEqual({ stripeAccount: c.account });
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.itemsOn(c.account)).toHaveLength(2);
    });

    it("does not adopt another request's invoice and creates when nothing matches after 24h", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      // An older, unrelated invoice for the same customer (another key).
      expect((await post(c.apiKey, body(cust), "unrelated")).statusCode).toBe(201);
      stripe.failNth("invoices.create", 2, stripeApiError(500));
      expect((await post(c.apiKey, body(cust), "later")).statusCode).toBe(502);
      stripe.expireIdempotencyKeys();
      await db
        .update(connectInvoices)
        .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
        .where(eq(connectInvoices.id, (await rowIdByKey(c.id, "later")) as string));
      const res = await post(c.apiKey, body(cust), "later");
      expect(res.statusCode).toBe(201);
      expect(stripe.invoicesOn(c.account)).toHaveLength(2);
      expect(stripe.callsTo("invoices.list")).toHaveLength(1);
    });

    async function ageRow(clientId: string, key: string) {
      await db
        .update(connectInvoices)
        .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
        .where(eq(connectInvoices.id, (await rowIdByKey(clientId, key)) as string));
    }

    async function leaveOrphan(c: Seeded, cust: string, key: string) {
      vi.spyOn(db, "update").mockImplementationOnce((() => {
        throw new Error("db down");
      }) as never);
      expect((await post(c.apiKey, body(cust), key)).statusCode).toBe(503);
      vi.restoreAllMocks();
      const orphan = stripe.invoicesOn(c.account)[0];
      stripe.expireIdempotencyKeys();
      await ageRow(c.id, key);
      return orphan;
    }

    const junk = (c: Seeded, cust: string, n: number) => {
      for (let i = 0; i < n; i++) {
        stripe.seedInvoice(c.account, {
          id: `in_junk_${c.id.slice(0, 6)}_${i}`,
          customer: cust,
          metadata: { dfwsc_idem_key: sha(`other-${i}`), dfwsc_client_id: c.id },
        });
      }
    };

    it("adopts a match found beyond page 10 and creates nothing", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const orphan = await leaveOrphan(c, cust, "deep");
      junk(c, cust, 1050); // the orphan is now the oldest: page 11 of 100
      const res = await post(c.apiKey, body(cust), "deep");
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe(orphan.id);
      expect(stripe.callsTo("invoices.list")).toHaveLength(11);
      expect(stripe.callsTo("invoices.create")).toHaveLength(1);
      for (const call of stripe.callsTo("invoices.list")) {
        expect(call.options).toEqual({ stripeAccount: c.account });
        expect(call.params).toMatchObject({ customer: cust, limit: 100 });
      }
    });

    it("never adopts on client id alone or key alone", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const orphan = await leaveOrphan(c, cust, "both");
      // Same key hash but another client's id, and same client but another key: not ours.
      stripe.seedInvoice(c.account, {
        id: "in_wrong_client",
        customer: cust,
        metadata: { dfwsc_idem_key: sha("both"), dfwsc_client_id: "someone-else" },
      });
      stripe.seedInvoice(c.account, {
        id: "in_wrong_key",
        customer: cust,
        metadata: { dfwsc_idem_key: sha("nope"), dfwsc_client_id: c.id },
      });
      const res = await post(c.apiKey, body(cust), "both");
      expect(res.json().id).toBe(orphan.id);
    });

    it("answers 503 INVOICE_ADOPTION_INCOMPLETE and creates nothing when the search runs out of pages", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      await leaveOrphan(c, cust, "capped");
      junk(c, cust, INVOICE_ADOPTION_MAX_PAGES * 100 + 20); // the match is beyond the page cap
      const before = stripe.callsTo("invoices.create").length;
      const res = await post(c.apiKey, body(cust), "capped");
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("INVOICE_ADOPTION_INCOMPLETE");
      expect(stripe.callsTo("invoices.list")).toHaveLength(INVOICE_ADOPTION_MAX_PAGES);
      expect(stripe.callsTo("invoices.create")).toHaveLength(before);
      expect(stripe.callsTo("invoiceItems.create")).toHaveLength(0);
      const row = await rowOf(c.id, "capped");
      expect(row.creationState).toBe("reserved");
      expect(row.claimedAt).toBeNull();
    }, 60_000);

    it("adopts invoice items by metadata after the key window instead of duplicating them", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const two = body(cust, {
        lines: [
          { description: "Rent", unitAmountCents: 100_000 },
          { description: "Parking", unitAmountCents: 2500 },
        ],
      });
      // Persist invoice id (update #1) but lose line 0's id (update #2): the item exists on Stripe.
      const real = db.update.bind(db);
      let n = 0;
      vi.spyOn(db, "update").mockImplementation(((...args: Parameters<typeof real>) => {
        n += 1;
        if (n === 2) throw new Error("db down");
        return real(...args);
      }) as never);
      expect((await post(c.apiKey, two, "items-old")).statusCode).toBe(503);
      vi.restoreAllMocks();
      expect(stripe.itemsOn(c.account)).toHaveLength(1);

      stripe.expireIdempotencyKeys();
      await db
        .update(connectInvoices)
        .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
        .where(eq(connectInvoices.id, (await rowIdByKey(c.id, "items-old")) as string));
      const res = await post(c.apiKey, two, "items-old");
      expect(res.statusCode).toBe(201);
      expect(stripe.callsTo("invoiceItems.list")).toHaveLength(1);
      expect(stripe.itemsOn(c.account).map((i) => i.description)).toEqual([
        "Rent",
        "Parking",
        "Processing Fee",
      ]);
      expect(res.json().totalCents).toBe(102_750);
    });
  });

  describe("POST /invoices: Stripe disagrees", () => {
    it("fails safely with 502 INVOICE_TOTAL_MISMATCH, leaves the draft, and a retry re-verifies", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      stripe.retrieveOverrides["*"] = { total: 1 };
      const res = await post(c.apiKey, body(cust), "mismatch");
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("INVOICE_TOTAL_MISMATCH");
      // The draft stays on the account, unsent; the row is not complete and is hidden.
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.invoicesOn(c.account)[0].status).toBe("draft");
      const row = await rowOf(c.id, "mismatch");
      expect(row.creationState).toBe("lines_added");
      expect((await get(c.apiKey, "/api/v1/invoices")).json().data).toEqual([]);
      expect((await get(c.apiKey, `/api/v1/invoices/${row.stripeInvoiceId}`)).statusCode).toBe(404);

      // The same mismatch again: still refused, nothing re-created.
      expect((await post(c.apiKey, body(cust), "mismatch")).statusCode).toBe(502);
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
      expect(stripe.itemsOn(c.account)).toHaveLength(2);

      // Stripe agrees again: the retry completes the same invoice.
      stripe.retrieveOverrides = {};
      const ok = await post(c.apiKey, body(cust), "mismatch");
      expect(ok.json()).toEqual(expect.anything());
      expect(ok.statusCode, JSON.stringify(ok.json())).toBe(201);
      expect(ok.json().id).toBe(row.stripeInvoiceId);
      expect(stripe.invoicesOn(c.account)).toHaveLength(1);
    });

    it("rejects a Stripe-reported application fee that differs from the computed one", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      stripe.retrieveOverrides["*"] = { application_fee_amount: 1 };
      const res = await post(c.apiKey, body(cust));
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("INVOICE_TOTAL_MISMATCH");
    });

    it("rejects a non-draft or non-usd invoice", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      stripe.retrieveOverrides["*"] = { status: "open" };
      expect((await post(c.apiKey, body(cust))).json().code).toBe("INVOICE_TOTAL_MISMATCH");
      stripe.retrieveOverrides["*"] = { currency: "eur" };
      expect((await post(c.apiKey, body(cust), "eur")).json().code).toBe("INVOICE_TOTAL_MISMATCH");
    });

    it("maps Stripe errors on create", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      stripe.failNth("invoices.create", 1, stripeApiError(400));
      const invalid = await post(c.apiKey, body(cust));
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe("INVALID_REQUEST");
      stripe.failNth("invoices.create", 2, stripeApiError(429));
      const limited = await post(c.apiKey, body(cust));
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
    });
  });

  describe("GET /invoices/:id", () => {
    it("returns a whitelisted object for the owner and 404 for others and unknown ids", async () => {
      const c = await seedClient();
      const other = await seedClient();
      const cust = await seedCustomer(c);
      const created = await post(c.apiKey, body(cust));
      const id = created.json().id;
      stripe.calls.length = 0;

      const res = await get(c.apiKey, `/api/v1/invoices/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(created.json());
      expect(res.json()).not.toHaveProperty("object");
      expect(res.json()).not.toHaveProperty("lines");

      expect((await get(other.apiKey, `/api/v1/invoices/${id}`)).statusCode).toBe(404);
      expect((await get(c.apiKey, "/api/v1/invoices/in_nope")).statusCode).toBe(404);
      // Fresh row: no Stripe call at all.
      expect(stripe.calls).toHaveLength(0);
    });

    it("hides rows that are not complete", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      await seedInvoiceRow(c, cust, {
        creationState: "invoice_created",
        stripeInvoiceId: "in_part",
      });
      expect((await get(c.apiKey, "/api/v1/invoices/in_part")).statusCode).toBe(404);
    });

    async function staleInvoice(c: Seeded, cust: string, key = randomUUID()) {
      const created = await post(c.apiKey, body(cust), key);
      const id = created.json().id as string;
      await db
        .update(connectInvoices)
        .set({ lastSyncedAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(connectInvoices.stripeInvoiceId, id));
      stripe.calls.length = 0;
      return id;
    }

    it("re-checks a non-terminal row older than 30s once on the account and writes it back", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const id = await staleInvoice(c, cust);
      Object.assign(stripe.invoicesOn(c.account)[0], {
        status: "open",
        number: "ABC-0001",
        hosted_invoice_url: "https://invoice.stripe.com/i/acct/live_token",
        invoice_pdf: "https://pay.stripe.com/pdf",
        due_date: 1_900_000_000,
        status_transitions: {
          finalized_at: 1_800_000_000,
          paid_at: null,
          voided_at: null,
          marked_uncollectible_at: null,
        },
      });

      const res = await get(c.apiKey, `/api/v1/invoices/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "open",
        number: "ABC-0001",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/live_token",
        finalizedAt: new Date(1_800_000_000_000).toISOString(),
        dueDate: new Date(1_900_000_000_000).toISOString(),
      });
      expect(stripe.callsTo("invoices.retrieve")).toHaveLength(1);
      expect(stripe.callsTo("invoices.retrieve")[0].options).toMatchObject({
        stripeAccount: c.account,
        maxNetworkRetries: 0,
      });

      // Written back and fresh now: the next read is answered from Postgres.
      const [row] = await db
        .select()
        .from(connectInvoices)
        .where(eq(connectInvoices.stripeInvoiceId, id));
      expect(row.status).toBe("open");
      expect(Date.now() - (row.lastSyncedAt as Date).getTime()).toBeLessThan(10_000);
      expect((await get(c.apiKey, `/api/v1/invoices/${id}`)).json().status).toBe("open");
      expect(stripe.callsTo("invoices.retrieve")).toHaveLength(1);
    });

    it("records a paid transition", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const id = await staleInvoice(c, cust);
      Object.assign(stripe.invoicesOn(c.account)[0], {
        status: "paid",
        amount_paid: 100_250,
        amount_remaining: 0,
        status_transitions: {
          finalized_at: 1_800_000_000,
          paid_at: 1_800_000_500,
          voided_at: null,
          marked_uncollectible_at: null,
        },
      });
      const res = (await get(c.apiKey, `/api/v1/invoices/${id}`)).json();
      expect(res).toMatchObject({
        status: "paid",
        amountPaidCents: 100_250,
        amountRemainingCents: 0,
      });
      expect(res.paidAt).toBe(new Date(1_800_000_500_000).toISOString());
    });

    it("throttles a failing re-check and never fails the request", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const id = await staleInvoice(c, cust);
      stripe.failNth("invoices.retrieve", 1, stripeApiError(500));
      const first = await get(c.apiKey, `/api/v1/invoices/${id}`);
      expect(first.statusCode).toBe(200);
      expect(first.json().status).toBe("draft");
      // Still stale in Postgres, but not asked again within the interval.
      const second = await get(c.apiKey, `/api/v1/invoices/${id}`);
      expect(second.statusCode).toBe(200);
      expect(stripe.callsTo("invoices.retrieve")).toHaveLength(1);
    });

    it("survives a missing Stripe invoice (404) on re-check", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const id = await staleInvoice(c, cust);
      stripe.failNth("invoices.retrieve", 1, stripeApiError(404));
      expect((await get(c.apiKey, `/api/v1/invoices/${id}`)).statusCode).toBe(200);
    });

    it("skips the re-check when the circuit is open", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const id = await staleInvoice(c, cust);
      openStripeCircuitForTests();
      const res = await get(c.apiKey, `/api/v1/invoices/${id}`);
      expect(res.statusCode).toBe(200);
      expect(stripe.calls).toHaveLength(0);
    });

    it("never re-checks a terminal row", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      for (const status of ["paid", "void", "uncollectible", "deleted"] as const) {
        const rowId = await seedInvoiceRow(c, cust, {
          status,
          lastSyncedAt: new Date(Date.now() - 60 * 60_000),
        });
        const [row] = await db.select().from(connectInvoices).where(eq(connectInvoices.id, rowId));
        expect((await get(c.apiKey, `/api/v1/invoices/${row.stripeInvoiceId}`)).statusCode).toBe(
          200
        );
      }
      expect(stripe.calls).toHaveLength(0);
    });
  });

  describe("GET /invoices", () => {
    it("lists nothing for a new client, from Postgres only", async () => {
      const c = await seedClient();
      const res = await get(c.apiKey, "/api/v1/invoices");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], nextCursor: null });
      expect(stripe.calls).toHaveLength(0);
    });

    it("pages newest first with an opaque keyset cursor, including ties on created_at", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const base = Date.now() - 10 * 60_000;
      const tie = new Date(base + 2000);
      const ids: string[] = [];
      for (const t of [
        new Date(base),
        new Date(base + 1000),
        tie,
        tie,
        tie,
        new Date(base + 3000),
        new Date(base + 4000),
      ]) {
        ids.push(await seedInvoiceRow(c, cust, { createdAt: t }));
      }
      const all: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: any = await get(
          c.apiKey,
          `/api/v1/invoices?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json.data.length).toBeLessThanOrEqual(2);
        all.push(...json.data.map((d: any) => d.id));
        cursor = json.nextCursor;
        pages += 1;
        if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      } while (cursor);
      expect(pages).toBe(4);
      expect(new Set(all).size).toBe(7);

      const rows = await db
        .select()
        .from(connectInvoices)
        .where(eq(connectInvoices.clientId, c.id));
      const byId = new Map(rows.map((r) => [r.stripeInvoiceId, r]));
      const expected = [...rows]
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        )
        .map((r) => r.stripeInvoiceId);
      expect(all).toEqual(expected);
      expect(byId.size).toBe(7);
      expect(stripe.calls).toHaveLength(0);
    });

    it("filters by status and customerId, alone and with paging, and scopes to the client", async () => {
      const c = await seedClient();
      const other = await seedClient();
      const [c1, c2] = [await seedCustomer(c), await seedCustomer(c)];
      const otherCust = await seedCustomer(other);
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        await seedInvoiceRow(c, c1, { status: "draft", createdAt: new Date(now - i * 1000) });
      }
      await seedInvoiceRow(c, c1, { status: "paid", createdAt: new Date(now - 5000) });
      await seedInvoiceRow(c, c2, { status: "draft", createdAt: new Date(now - 6000) });
      await seedInvoiceRow(c, c2, { status: "open", createdAt: new Date(now - 7000) });
      await seedInvoiceRow(other, otherCust, { status: "draft" });
      // Not complete: never listed.
      await seedInvoiceRow(c, c1, { creationState: "reserved", stripeInvoiceId: null });

      const list = async (qs: string) => (await get(c.apiKey, `/api/v1/invoices${qs}`)).json();
      expect((await list("")).data).toHaveLength(6);
      expect((await list("?status=draft")).data).toHaveLength(4);
      expect((await list("?status=paid")).data).toHaveLength(1);
      expect((await list(`?customerId=${c1}`)).data).toHaveLength(4);
      expect((await list(`?customerId=${c2}&status=open`)).data).toHaveLength(1);
      expect((await list(`?customerId=${otherCust}`)).data).toEqual([]);

      const page1 = await list(`?status=draft&customerId=${c1}&limit=2`);
      expect(page1.data).toHaveLength(2);
      const page2 = await list(
        `?status=draft&customerId=${c1}&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`
      );
      expect(page2.data).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      expect(new Set([...page1.data, ...page2.data].map((d: any) => d.id)).size).toBe(3);
    });

    it("defaults to 25, caps at 100, and rejects bad limits, statuses and cursors", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const now = Date.now();
      await db.insert(connectInvoices).values(
        Array.from({ length: 30 }, (_, i) => {
          const id = randomUUID();
          return {
            id,
            clientId: c.id,
            connectedAccountId: c.account,
            stripeCustomerId: cust,
            idempotencyKey: sha(id),
            requestHash: sha("r"),
            creationState: "complete" as const,
            stripeInvoiceId: `in_bulk_${id.slice(0, 10)}`,
            currency: "usd",
            subtotalCents: 1,
            feeAmountCents: 0,
            totalCents: 1,
            amountRemainingCents: 1,
            createdAt: new Date(now - i * 1000),
          };
        })
      );
      const def = (await get(c.apiKey, "/api/v1/invoices")).json();
      expect(def.data).toHaveLength(25);
      expect(def.nextCursor).toBeTruthy();
      const max = (await get(c.apiKey, "/api/v1/invoices?limit=100")).json();
      expect(max.data).toHaveLength(30);
      expect(max.nextCursor).toBeNull();
      expect((await get(c.apiKey, "/api/v1/invoices?limit=1")).json().data).toHaveLength(1);

      for (const qs of [
        "limit=0",
        "limit=101",
        "limit=abc",
        "limit=1.5",
        "status=bogus",
        "cursor=not-a-cursor",
        `cursor=${Buffer.from(JSON.stringify({ c: "nope", i: "x" })).toString("base64url")}`,
      ]) {
        expect((await get(c.apiKey, `/api/v1/invoices?${qs}`)).statusCode, qs).toBe(400);
      }
    });
  });

  describe("every Stripe call is made on the client's account", () => {
    it("carries stripeAccount === the client's account on create, resume, adopt, list and re-check", async () => {
      const a = await seedClient();
      const b = await seedClient();
      const custA = await seedCustomer(a);
      const custB = await seedCustomer(b);

      // Create, replay, resume after a failure, adopt after the window, stale re-check.
      expect((await post(a.apiKey, body(custA), "g1")).statusCode).toBe(201);
      expect((await post(a.apiKey, body(custA), "g1")).statusCode).toBe(200);
      stripe.failNth("invoiceItems.create", 3, stripeApiError(500));
      await post(a.apiKey, body(custA), "g2");
      expect((await post(a.apiKey, body(custA), "g2")).statusCode).toBe(201);

      vi.spyOn(db, "update").mockImplementationOnce((() => {
        throw new Error("db down");
      }) as never);
      expect((await post(b.apiKey, body(custB), "g3")).statusCode).toBe(503);
      vi.restoreAllMocks();
      stripe.expireIdempotencyKeys();
      await db
        .update(connectInvoices)
        .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
        .where(eq(connectInvoices.id, (await rowIdByKey(b.id, "g3")) as string));
      expect((await post(b.apiKey, body(custB), "g3")).statusCode).toBe(201);

      await db
        .update(connectInvoices)
        .set({ lastSyncedAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(connectInvoices.clientId, a.id));
      const listed = (await get(a.apiKey, "/api/v1/invoices")).json();
      for (const inv of listed.data) await get(a.apiKey, `/api/v1/invoices/${inv.id}`);

      const used = new Set(stripe.calls.map((x) => x.call));
      for (const call of [
        "invoices.create",
        "invoiceItems.create",
        "invoices.retrieve",
        "invoices.list",
        "invoiceItems.list",
      ]) {
        if (call === "invoiceItems.list") continue; // covered by the items adoption test
        expect(used.has(call), call).toBe(true);
      }
      expect(stripe.calls.length).toBeGreaterThan(10);
      for (const call of stripe.calls) {
        expect(ALLOWED_CONNECT_CALLS.has(call.call), call.call).toBe(true);
        expect(call.options?.stripeAccount, `${call.call} has stripeAccount`).toBeDefined();
        const owner = [a, b].find((x) => x.account === call.options?.stripeAccount);
        expect(owner, `${call.call} runs on a known client account`).toBeDefined();
        // Customers and invoices never cross accounts.
        const customer = call.params?.customer;
        if (typeof customer === "string") {
          expect(customer).toBe(owner === a ? custA : custB);
        }
        // Idempotency keys are namespaced by the owning client.
        const key = call.options?.idempotencyKey as string | undefined;
        if (key) expect(key.startsWith(`${owner?.id}:inv:`)).toBe(true);
      }
    });
  });

  describe("rate limits", () => {
    const bucketKey = (account: string) =>
      `ratelimit:bucket:POST:/api/v1/invoices:stripe:${account}`;

    it("charges one write token per accepted create, keyed by the connected account", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
      const c = await seedClient();
      await post(c.apiKey, body(await seedCustomer(c)));
      expect(tokenBuckets.get(bucketKey(c.account))?.tokens).toBe(299);
    });

    it("refunds the token when the circuit is open and nothing reached Stripe", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
      const c = await seedClient();
      const cust = await seedCustomer(c);
      openStripeCircuitForTests();
      const res = await post(c.apiKey, body(cust));
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("STRIPE_CIRCUIT_OPEN");
      expect(stripe.calls).toHaveLength(0);
      expect(tokenBuckets.get(bucketKey(c.account))?.tokens).toBe(300);
    });

    it("answers 429 when the write bucket is empty, before any Stripe call", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
      const c = await seedClient();
      const cust = await seedCustomer(c);
      tokenBuckets.set(bucketKey(c.account), { tokens: 0, updatedAt: Date.now() } as never);
      const res = await post(c.apiKey, body(cust));
      expect(res.statusCode).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(stripe.calls).toHaveLength(0);
      expect(
        await db.select().from(connectInvoices).where(eq(connectInvoices.clientId, c.id))
      ).toHaveLength(0);
    });
  });

  describe("logging", () => {
    it("never logs a hosted URL, PDF link, customer email or customer-supplied text", async () => {
      const lines: string[] = [];
      const rec = (...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      };
      const recorder: Record<string, unknown> = {
        level: "info",
        info: rec,
        warn: rec,
        error: rec,
        debug: rec,
        trace: rec,
        fatal: rec,
        silent: rec,
      };
      recorder.child = () => recorder;
      const logged = await buildServer();
      logged.addHook("onRequest", async (request: any) => {
        request.log = recorder;
      });

      const c = await seedClient();
      const email = "secret.tenant@example.com";
      const cust = await seedCustomer(c, email);
      const send = (method: string, url: string, payload?: unknown, key?: string) =>
        logged.inject({
          method: method as any,
          url,
          headers: { "x-api-key": c.apiKey, ...(key ? { "idempotency-key": key } : {}) },
          payload: payload as any,
        });
      const secretBody = body(cust, {
        lines: [{ description: "Secret Unit 12B rent", unitAmountCents: 1000 }],
        description: "Secret memo text",
        metadata: { note: "secret-note" },
      });
      stripe.retrieveOverrides["*"] = {
        hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/live_SECRET_TOKEN",
        invoice_pdf: "https://pay.stripe.com/invoice/acct_x/SECRET_PDF/pdf",
      };

      const created = (await send("POST", "/api/v1/invoices", secretBody, "log-1")).json();
      expect(created.hostedInvoiceUrl).toContain("SECRET_TOKEN"); // returned, never logged

      // A Stripe failure whose message quotes the email.
      const { default: Stripe } = await import("stripe");
      stripe.failNth(
        "invoices.create",
        2,
        new Stripe.errors.StripeAPIError({
          type: "api_error",
          statusCode: 500,
          message: `bad customer ${email} https://invoice.stripe.com/i/acct_x/live_SECRET_TOKEN`,
        } as never)
      );
      await send("POST", "/api/v1/invoices", secretBody, "log-2");
      // A mismatch, a Postgres failure, and a failing re-check.
      stripe.retrieveOverrides["*"] = {
        total: 3,
        hosted_invoice_url: "https://x/live_SECRET_TOKEN",
      };
      await send("POST", "/api/v1/invoices", secretBody, "log-3");
      stripe.retrieveOverrides = {};
      vi.spyOn(db, "update").mockImplementationOnce((() => {
        throw new Error(`db down ${email}`);
      }) as never);
      await send("POST", "/api/v1/invoices", secretBody, "log-4");
      vi.restoreAllMocks();
      await db
        .update(connectInvoices)
        .set({ lastSyncedAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(connectInvoices.stripeInvoiceId, created.id));
      stripe.failNth(
        "invoices.retrieve",
        stripe.callsTo("invoices.retrieve").length + 1,
        new Stripe.errors.StripeAPIError({
          type: "api_error",
          statusCode: 500,
          message: `quoted ${email}`,
        } as never)
      );
      await send("GET", `/api/v1/invoices/${created.id}`);
      await send("GET", "/api/v1/invoices");
      await logged.close();

      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join("\n");
      for (const secret of [
        "SECRET_TOKEN",
        "SECRET_PDF",
        "invoice.stripe.com",
        "pay.stripe.com",
        "secret.tenant",
        "Secret Unit",
        "Secret memo",
        "secret-note",
      ]) {
        expect(all, secret).not.toContain(secret);
      }
      expect(all).toContain(c.id);
    });
  });
});
