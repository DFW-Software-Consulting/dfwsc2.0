import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The real fake for invoices, plus a constructEvent that just parses the body (signatures are not
// the subject here; webhooks.test.ts covers them).
vi.mock("../../lib/stripe", async () => {
  const { fakeConnectInvoicing } = await import("../helpers/fake-stripe-connect-invoicing");
  return {
    stripe: {
      invoices: fakeConnectInvoicing.stripe.invoices,
      webhooks: { constructEvent: (raw: string) => JSON.parse(raw) },
    },
  };
});

import { eq, inArray } from "drizzle-orm";
import Stripe from "stripe";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import {
  clients,
  connectCustomers,
  connectInvoiceSends,
  connectInvoices,
  webhookEvents,
} from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import {
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
  resetStripeConcurrencyForTests,
} from "../../lib/circuit-breakers";
import { syncConnectInvoice } from "../../lib/connect-invoice-sync";
import { tokenBuckets } from "../../lib/rate-limit";
import {
  fakeConnectInvoicing as stripe,
  stripeApiError,
} from "../helpers/fake-stripe-connect-invoicing";

const CONNECT_URL = "/api/v1/webhooks/stripe";
const BILLING_URL = "/api/v1/webhooks/stripe-billing";
const T0 = 1_900_000_000;
const HOSTED = "https://invoice.example/hosted-secret";
const PDF = "https://invoice.example/hosted-secret/pdf";
const EMAIL = "tenant.private@example.com";

type Seeded = { id: string; apiKey: string; account: string };

describe("Connect webhook sync of connected-account invoices", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const clientIds: string[] = [];
  const eventIds: string[] = [];

  async function seedClient(): Promise<Seeded> {
    const id = randomUUID();
    const apiKey = `whk_key_${randomUUID().replace(/-/g, "")}`;
    const account = `acct_whk_${id.slice(0, 8)}`;
    await db.insert(clients).values({
      id,
      name: "Webhook Client",
      email: `whk-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: account,
      chargesEnabled: true,
      invoicingEnabled: true,
      processingFeeCents: 250,
    });
    await db.insert(connectCustomers).values({
      id: randomUUID(),
      clientId: id,
      connectedAccountId: account,
      stripeCustomerId: "cus_whk",
      externalRef: null,
      idempotencyKey: randomUUID(),
    });
    clientIds.push(id);
    return { id, apiKey, account };
  }

  /**
   * A complete row plus the same invoice on the fake Stripe. `stripeOver` is what Stripe says now;
   * `rowOver` is what we stored.
   */
  async function seedInvoice(
    c: Seeded,
    rowOver: Partial<typeof connectInvoices.$inferInsert> = {},
    stripeOver: Record<string, unknown> = {}
  ) {
    const stripeInvoiceId = `in_whk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(connectInvoices).values({
      id: randomUUID(),
      clientId: c.id,
      connectedAccountId: c.account,
      stripeCustomerId: "cus_whk",
      idempotencyKey: randomUUID(),
      requestHash: "h",
      creationState: "complete",
      stripeInvoiceId,
      status: "open",
      currency: "usd",
      subtotalCents: 100_000,
      feeAmountCents: 250,
      totalCents: 100_250,
      amountRemainingCents: 100_250,
      ...rowOver,
    });
    stripe.seedInvoice(c.account, {
      id: stripeInvoiceId,
      customer: "cus_whk",
      status: "open",
      total: 100_250,
      amount_paid: 0,
      amount_remaining: 100_250,
      number: "FAKE-0001",
      hosted_invoice_url: HOSTED,
      invoice_pdf: PDF,
      description: null,
      status_transitions: { finalized_at: T0 - 100 },
      ...stripeOver,
    });
    return stripeInvoiceId;
  }

  const rowOf = async (stripeInvoiceId: string) =>
    (
      await db
        .select()
        .from(connectInvoices)
        .where(eq(connectInvoices.stripeInvoiceId, stripeInvoiceId))
    )[0];

  function makeEvent(
    type: string,
    invoiceId: string,
    account: string | undefined,
    created = T0,
    id = `evt_${randomUUID().replace(/-/g, "")}`
  ) {
    eventIds.push(id);
    return {
      id,
      object: "event",
      type,
      created,
      ...(account ? { account } : {}),
      data: { object: { id: invoiceId, object: "invoice" } },
    };
  }

  const post = (event: unknown, url = CONNECT_URL) =>
    app.inject({
      method: "POST",
      url,
      body: JSON.stringify(event),
      headers: { "content-type": "application/json", "stripe-signature": "sig" },
    });

  const retrieves = () => stripe.callsTo("invoices.retrieve");

  function recorder() {
    const lines: string[] = [];
    const rec = (...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    };
    return {
      lines,
      logger: { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec } as never,
    };
  }

  beforeAll(async () => {
    process.env.CONNECT_INVOICING = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_1234567890";
    process.env.FRONTEND_ORIGIN = "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test";
    app = await buildServer();
  });

  afterAll(async () => {
    if (eventIds.length > 0) {
      await db.delete(webhookEvents).where(inArray(webhookEvents.stripeEventId, eventIds));
    }
    if (clientIds.length > 0) await db.delete(clients).where(inArray(clients.id, clientIds));
    delete process.env.CONNECT_INVOICING;
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    await app.close();
  });

  beforeEach(() => {
    stripe.reset();
    resetCircuitBreakersForTests();
    tokenBuckets.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetStripeConcurrencyForTests();
  });

  describe("each event syncs the row from the re-read invoice", () => {
    const cases: Array<{
      type: string;
      rowStatus: "draft" | "open" | "uncollectible";
      stripe: Record<string, unknown>;
      expected: string;
      check?: (row: typeof connectInvoices.$inferSelect) => void;
    }> = [
      {
        type: "invoice.finalized",
        rowStatus: "draft",
        stripe: { status: "open" },
        expected: "open",
        check: (r) => {
          expect(r.number).toBe("FAKE-0001");
          expect(r.hostedInvoiceUrl).toBe(HOSTED);
          expect(r.invoicePdf).toBe(PDF);
          expect(r.finalizedAt).toEqual(new Date((T0 - 100) * 1000));
        },
      },
      { type: "invoice.sent", rowStatus: "open", stripe: {}, expected: "open" },
      {
        type: "invoice.paid",
        rowStatus: "open",
        stripe: {
          status: "paid",
          amount_paid: 100_250,
          amount_remaining: 0,
          status_transitions: { finalized_at: T0 - 100, paid_at: T0 - 10 },
        },
        expected: "paid",
        check: (r) => {
          expect(r.amountPaidCents).toBe(100_250);
          expect(r.amountRemainingCents).toBe(0);
          expect(r.paidAt).toEqual(new Date((T0 - 10) * 1000));
        },
      },
      {
        type: "invoice.payment_succeeded",
        rowStatus: "open",
        stripe: { status: "paid", amount_paid: 100_250, amount_remaining: 0 },
        expected: "paid",
      },
      {
        type: "invoice.payment_failed",
        rowStatus: "open",
        stripe: {},
        expected: "open",
      },
      {
        type: "invoice.voided",
        rowStatus: "open",
        stripe: {
          status: "void",
          amount_remaining: 0,
          status_transitions: { finalized_at: T0 - 100, voided_at: T0 - 5 },
        },
        expected: "void",
        check: (r) => expect(r.voidedAt).toEqual(new Date((T0 - 5) * 1000)),
      },
      {
        type: "invoice.marked_uncollectible",
        rowStatus: "open",
        stripe: { status: "uncollectible" },
        expected: "uncollectible",
      },
      {
        type: "invoice.updated",
        rowStatus: "open",
        stripe: { description: "Edited in the dashboard", metadata: { unit: "7", dfwsc_x: "1" } },
        expected: "open",
        check: (r) => {
          expect(r.description).toBe("Edited in the dashboard");
          expect(r.metadata).toEqual({ unit: "7" });
        },
      },
      {
        // The invoice is gone from Stripe: a draft row becomes deleted.
        type: "invoice.deleted",
        rowStatus: "draft",
        stripe: {},
        expected: "deleted",
      },
    ];

    for (const tc of cases) {
      it(tc.type, async () => {
        const c = await seedClient();
        const id = await seedInvoice(c, { status: tc.rowStatus }, tc.stripe);
        if (tc.type === "invoice.deleted") stripe.reset(); // nothing on Stripe: retrieve is a 404
        const res = await post(makeEvent(tc.type, id, c.account));
        expect(res.statusCode).toBe(200);
        const row = await rowOf(id);
        expect(row.status).toBe(tc.expected);
        expect(row.lastSyncedAt).toBeInstanceOf(Date);
        expect(row.lastStripeEventCreatedAt).toBe(T0);
        tc.check?.(row);
        if (tc.type === "invoice.deleted") return;
        expect(retrieves()).toHaveLength(1);
        expect(retrieves()[0].options).toMatchObject({ stripeAccount: c.account });
      });
    }

    it("logs a failed payment attempt", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      const warn = vi.spyOn(app.log, "warn");
      await post(makeEvent("invoice.payment_failed", id, c.account));
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: id }),
        "Invoice payment failed."
      );
    });
  });

  describe("rows and events that are ignored", () => {
    it("acks an event without an account: no Stripe call, no write", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      const res = await post(makeEvent("invoice.paid", id, undefined));
      expect(res.statusCode).toBe(200);
      expect(retrieves()).toHaveLength(0);
      const row = await rowOf(id);
      expect(row.lastSyncedAt).toBeNull();
      expect(row.lastStripeEventCreatedAt).toBeNull();
    });

    it("acks an unknown invoice, and an invoice id seen on another account", async () => {
      const c = await seedClient();
      const other = await seedClient();
      const id = await seedInvoice(c);
      expect((await post(makeEvent("invoice.paid", "in_not_ours", c.account))).statusCode).toBe(
        200
      );
      expect((await post(makeEvent("invoice.paid", id, other.account))).statusCode).toBe(200);
      expect(retrieves()).toHaveLength(0);
      expect((await rowOf(id)).lastSyncedAt).toBeNull();
    });

    it("skips rows whose creation is not complete", async () => {
      const c = await seedClient();
      for (const creationState of ["reserved", "invoice_created", "lines_added"] as const) {
        const id = await seedInvoice(c, { creationState, status: "draft" }, { status: "open" });
        expect((await post(makeEvent("invoice.finalized", id, c.account))).statusCode).toBe(200);
        const row = await rowOf(id);
        expect(row.status).toBe("draft");
        expect(row.lastSyncedAt).toBeNull();
      }
      expect(retrieves()).toHaveLength(0);
    });

    it("acks an invoice event without an invoice id", async () => {
      const event = makeEvent("invoice.paid", "x", "acct_whk_none");
      (event.data.object as { id?: string }).id = undefined;
      expect((await post(event)).statusCode).toBe(200);
      expect(retrieves()).toHaveLength(0);
    });
  });

  describe("Stripe errors on the re-read", () => {
    it("a 404 marks a draft deleted but never a non-draft row", async () => {
      const c = await seedClient();
      const draft = await seedInvoice(c, { status: "draft" });
      const open = await seedInvoice(c, { status: "open" });
      stripe.reset();
      expect((await post(makeEvent("invoice.deleted", draft, c.account))).statusCode).toBe(200);
      expect((await post(makeEvent("invoice.deleted", open, c.account))).statusCode).toBe(200);
      expect((await rowOf(draft)).status).toBe("deleted");
      expect((await rowOf(open)).status).toBe("open");
    });

    it("warns with ids and status when a 404 hits a row past draft", async () => {
      const c = await seedClient();
      const paid = await seedInvoice(c, { status: "paid" });
      stripe.reset();
      const { lines, logger } = recorder();
      await syncConnectInvoice(makeEvent("invoice.deleted", paid, c.account) as never, logger);
      const row = await rowOf(paid);
      expect(row.status).toBe("paid");
      const all = lines.join("\n");
      expect(all).toContain("past draft");
      expect(all).toContain(paid);
      expect(all).toContain(c.account);
      expect(all).toContain(row.id);
      expect(all).toContain('"status":"paid"');
    });

    it("an open circuit answers non-2xx and releases the claim; the redelivery succeeds", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c, {}, { status: "paid", amount_paid: 100_250 });
      const event = makeEvent("invoice.paid", id, c.account);
      openStripeCircuitForTests();
      const res = await post(event);
      expect(res.statusCode).toBe(503);
      expect((await rowOf(id)).status).toBe("open");
      const [lease] = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.stripeEventId, event.id));
      expect(lease).toBeUndefined();

      resetCircuitBreakersForTests();
      expect((await post(event)).statusCode).toBe(200);
      expect((await rowOf(id)).status).toBe("paid");
    });

    it("401, 403, 409, 429, 5xx and connection errors answer non-2xx so Stripe retries", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      const errors = [
        stripeApiError(500),
        stripeApiError(429),
        new Stripe.errors.StripeAuthenticationError({
          type: "authentication_error",
          statusCode: 401,
        } as never),
        new Stripe.errors.StripePermissionError({
          type: "invalid_request_error",
          statusCode: 403,
        } as never),
        new Stripe.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          statusCode: 409,
        } as never),
        new Stripe.errors.StripeConnectionError({
          type: "api_error",
          message: "An error occurred with our connection to Stripe.",
        } as never),
      ];
      for (const [i, error] of errors.entries()) {
        stripe.reset();
        stripe.seedInvoice(c.account, { id, status: "paid" });
        stripe.failNth("invoices.retrieve", 1, error);
        const event = makeEvent("invoice.paid", id, c.account);
        const res = await post(event);
        expect(res.statusCode, `error ${i}`).toBeGreaterThanOrEqual(400);
        expect((await rowOf(id)).status).toBe("open");
        const [lease] = await db
          .select()
          .from(webhookEvents)
          .where(eq(webhookEvents.stripeEventId, event.id));
        expect(lease).toBeUndefined();
        resetCircuitBreakersForTests();
      }
    });

    it("a definite 400 is acked with a warn carrying the code and no Stripe message", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      stripe.failNth(
        "invoices.retrieve",
        1,
        new Stripe.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          statusCode: 400,
          code: "parameter_invalid_empty",
          message: `bad ${EMAIL} ${HOSTED}`,
        } as never)
      );
      const { lines, logger } = recorder();
      await syncConnectInvoice(makeEvent("invoice.paid", id, c.account) as never, logger);
      const all = lines.join("\n");
      expect(all).toContain("parameter_invalid_empty");
      expect(all).not.toContain(EMAIL);
      expect(all).not.toContain("invoice.example");
      expect((await rowOf(id)).status).toBe("open");
      expect((await rowOf(id)).lastSyncedAt).toBeNull();

      stripe.failNth("invoices.retrieve", 2, stripeApiError(400));
      expect((await post(makeEvent("invoice.paid", id, c.account))).statusCode).toBe(200);
    });

    it("the retry path logs ids and codes, never the Stripe message", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      stripe.failNth(
        "invoices.retrieve",
        1,
        new Stripe.errors.StripeAPIError({
          type: "api_error",
          statusCode: 500,
          code: "boom",
          message: `down for ${EMAIL} ${HOSTED}`,
        } as never)
      );
      const errorLog = vi.spyOn(app.log, "error");
      const event = makeEvent("invoice.paid", id, c.account);
      expect((await post(event)).statusCode).toBeGreaterThanOrEqual(500);
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).toContain(event.id);
      expect(logged).toContain("boom");
      expect(logged).toContain("500");
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain("invoice.example");
      expect(logged).not.toContain("errMessage");
      expect(logged).not.toContain("errStack");
    });

    it("the retry path logs the message and stack of a non-Stripe error", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      stripe.failNth("invoices.retrieve", 1, new TypeError("our own bug in the sync"));
      const errorLog = vi.spyOn(app.log, "error");
      const event = makeEvent("invoice.paid", id, c.account);
      expect((await post(event)).statusCode).toBeGreaterThanOrEqual(500);
      const entry = errorLog.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((o) => o?.eventId === event.id);
      expect(entry?.errMessage).toBe("our own bug in the sync");
      expect(String(entry?.errStack)).toContain("our own bug in the sync");
      expect(String(entry?.errStack)).toContain("at ");
    });

    it("the retry path logs only the SQLSTATE of a Drizzle query error, never params or stack", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      const pgErr = Object.assign(new Error(`duplicate for ${EMAIL}`), {
        code: "40001",
        severity: "ERROR",
        routine: "serialize",
        detail: `Key (url)=(${HOSTED}) ${EMAIL}`,
      });
      const drizzleErr = Object.assign(
        new Error(`Failed query: update "connect_invoices" params: ${HOSTED},${EMAIL}`),
        { name: "DrizzleQueryError", cause: pgErr }
      );
      stripe.failNth("invoices.retrieve", 1, drizzleErr);
      const errorLog = vi.spyOn(app.log, "error");
      const event = makeEvent("invoice.paid", id, c.account);
      expect((await post(event)).statusCode).toBeGreaterThanOrEqual(500);
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).toContain(event.id);
      expect(logged).toContain("40001");
      expect(logged).toContain("serialize");
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain("invoice.example");
      expect(logged).not.toContain("errStack");
      expect(logged).not.toContain("errMessage");
    });

    it("the retry path never logs the detail of a raw pg error", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      const pgErr = Object.assign(new Error(`pg says ${EMAIL}`), {
        code: "57014",
        severity: "ERROR",
        detail: `Row (${HOSTED}, ${EMAIL})`,
      });
      stripe.failNth("invoices.retrieve", 1, pgErr);
      const errorLog = vi.spyOn(app.log, "error");
      const event = makeEvent("invoice.paid", id, c.account);
      expect((await post(event)).statusCode).toBeGreaterThanOrEqual(500);
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).toContain("57014");
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain("invoice.example");
    });

    it("a Postgres failure during the sync answers non-2xx, releases the claim and a redelivery succeeds", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c, {}, { status: "paid", amount_paid: 100_250 });
      const event = makeEvent("invoice.paid", id, c.account);
      const original = db.update.bind(db);
      vi.spyOn(db, "update").mockImplementation(((table: unknown) => {
        if (table === connectInvoices) throw new Error(`db down ${EMAIL}`);
        return (original as any)(table);
      }) as never);
      const res = await post(event);
      expect(res.statusCode).toBe(500);
      expect((await rowOf(id)).status).toBe("open");
      const [lease] = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.stripeEventId, event.id));
      expect(lease).toBeUndefined();

      vi.restoreAllMocks();
      expect((await post(event)).statusCode).toBe(200);
      expect((await rowOf(id)).status).toBe("paid");
    });

    it("an invoice Stripe returns without a status is acked and not written", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c, {}, { status: null });
      expect((await post(makeEvent("invoice.updated", id, c.account))).statusCode).toBe(200);
      expect((await rowOf(id)).lastSyncedAt).toBeNull();
    });
  });

  describe("ordering and status guard", () => {
    it("never moves a paid row backward and keeps the newest event time", async () => {
      const c = await seedClient();
      const id = await seedInvoice(
        c,
        {},
        { status: "paid", amount_paid: 100_250, amount_remaining: 0 }
      );
      expect((await post(makeEvent("invoice.paid", id, c.account, T0 + 100))).statusCode).toBe(200);
      expect((await rowOf(id)).status).toBe("paid");

      // An older finalized event is read as of now: Stripe says paid, the row stays paid.
      expect((await post(makeEvent("invoice.finalized", id, c.account, T0))).statusCode).toBe(200);
      let row = await rowOf(id);
      expect(row.status).toBe("paid");
      expect(row.lastStripeEventCreatedAt).toBe(T0 + 100);

      // A stale read (Stripe answering open) cannot regress it either.
      stripe.retrieveOverrides[id] = { status: "open" };
      expect((await post(makeEvent("invoice.updated", id, c.account, T0 + 50))).statusCode).toBe(
        200
      );
      row = await rowOf(id);
      expect(row.status).toBe("paid");
      expect(row.lastStripeEventCreatedAt).toBe(T0 + 100);

      stripe.retrieveOverrides = {};
      expect((await post(makeEvent("invoice.updated", id, c.account, T0 + 200))).statusCode).toBe(
        200
      );
      expect((await rowOf(id)).lastStripeEventCreatedAt).toBe(T0 + 200);
    });

    it("syncs while a lifecycle claim is held and leaves claimed_at alone", async () => {
      const c = await seedClient();
      const claimedAt = new Date(Date.now() - 1000);
      const id = await seedInvoice(
        c,
        { claimedAt },
        { status: "paid", amount_paid: 100_250, amount_remaining: 0 }
      );
      expect((await post(makeEvent("invoice.paid", id, c.account))).statusCode).toBe(200);
      const row = await rowOf(id);
      expect(row.status).toBe("paid");
      expect(row.claimedAt).toEqual(claimedAt);
    });

    it("an uncollectible row can still become paid", async () => {
      const c = await seedClient();
      const id = await seedInvoice(
        c,
        { status: "uncollectible" },
        { status: "paid", amount_paid: 100_250, amount_remaining: 0 }
      );
      await post(makeEvent("invoice.paid", id, c.account));
      expect((await rowOf(id)).status).toBe("paid");
    });
  });

  describe("invoice.sent from the dashboard", () => {
    it("sets sent_at when null and never touches send_count or the send rows", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c, { sendCount: 2 });
      await post(makeEvent("invoice.sent", id, c.account, T0 + 7));
      const row = await rowOf(id);
      expect(row.sentAt).toEqual(new Date((T0 + 7) * 1000));
      expect(row.sendCount).toBe(2);
      expect(
        await db.select().from(connectInvoiceSends).where(eq(connectInvoiceSends.invoiceId, row.id))
      ).toHaveLength(0);
    });

    it("keeps an existing sent_at", async () => {
      const c = await seedClient();
      const before = new Date("2030-01-01T00:00:00Z");
      const id = await seedInvoice(c, { sentAt: before, sendCount: 1 });
      await post(makeEvent("invoice.sent", id, c.account, T0 + 7));
      const row = await rowOf(id);
      expect(row.sentAt).toEqual(before);
      expect(row.sendCount).toBe(1);
    });
  });

  describe("dedupe, the billing endpoint and the GET re-check", () => {
    it("a duplicate event id is acked from webhook_events without a second read", async () => {
      const c = await seedClient();
      const id = await seedInvoice(c);
      const event = makeEvent("invoice.updated", id, c.account);
      expect((await post(event)).statusCode).toBe(200);
      expect((await post(event)).statusCode).toBe(200);
      expect(retrieves()).toHaveLength(1);
    });

    it("a platform invoice event still takes the billing path and touches no connect row", async () => {
      process.env.STRIPE_BILLING_WEBHOOK_SECRET = "whsec_billing";
      const c = await seedClient();
      const id = await seedInvoice(c);
      const event = {
        ...makeEvent("invoice.paid", id, undefined),
        data: { object: { id, customer: "cus_unknown_to_billing" } },
      };
      const info = vi.spyOn(app.log, "info");
      const before = await rowOf(id);
      const res = await post(event, BILLING_URL);
      delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
      expect(res.statusCode).toBe(200);
      // The billing handler ran: it logged its own line for this event and marked it processed.
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: event.id, eventType: "invoice.paid", known: false }),
        "Billing webhook handled."
      );
      const [lease] = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.stripeEventId, event.id));
      expect(lease?.processedAt).toBeInstanceOf(Date);
      // The Connect sync did not: no Stripe read and the connect row is byte-for-byte unchanged.
      expect(retrieves()).toHaveLength(0);
      expect(await rowOf(id)).toEqual(before);
    });

    it("a webhook write resets the 30 s clock, so GET does not re-read the invoice", async () => {
      const c = await seedClient();
      const id = await seedInvoice(
        c,
        { lastSyncedAt: new Date(Date.now() - 120_000) },
        { status: "paid", amount_paid: 100_250, amount_remaining: 0 }
      );
      await post(makeEvent("invoice.paid", id, c.account));
      expect(retrieves()).toHaveLength(1);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/invoices/${id}`,
        headers: { "x-api-key": c.apiKey },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("paid");
      expect(retrieves()).toHaveLength(1);
    });

    it("still re-reads on GET when the row is stale and open", async () => {
      const c = await seedClient();
      const id = await seedInvoice(
        c,
        { lastSyncedAt: new Date(Date.now() - 120_000) },
        { status: "paid", amount_paid: 100_250, amount_remaining: 0 }
      );
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/invoices/${id}`,
        headers: { "x-api-key": c.apiKey },
      });
      expect(res.json().status).toBe("paid");
      expect(retrieves()).toHaveLength(1);
    });
  });

  describe("logging", () => {
    it("logs ids and codes only: no URL, PDF link or email", async () => {
      const c = await seedClient();
      const { lines, logger } = recorder();
      const ok = await seedInvoice(c, {}, { customer_email: EMAIL });
      await syncConnectInvoice(makeEvent("invoice.finalized", ok, c.account) as never, logger);
      await syncConnectInvoice(makeEvent("invoice.paid", ok, undefined) as never, logger);
      await syncConnectInvoice(makeEvent("invoice.paid", "in_unknown", c.account) as never, logger);
      const gone = await seedInvoice(c, { status: "draft" });
      stripe.failNth("invoices.retrieve", 1, stripeApiError(404));
      await syncConnectInvoice(makeEvent("invoice.deleted", gone, c.account) as never, logger);
      stripe.failNth("invoices.retrieve", 3, stripeApiError(400));
      await syncConnectInvoice(makeEvent("invoice.paid", ok, c.account) as never, logger);
      const all = lines.join("\n");
      expect(all.length).toBeGreaterThan(0);
      for (const secret of ["invoice.example", "hosted-secret", "/pdf", EMAIL, "tenant.private"]) {
        expect(all, secret).not.toContain(secret);
      }
      expect(all).toContain("evt_");
    });
  });
});
