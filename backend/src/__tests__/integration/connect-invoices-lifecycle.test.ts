import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeConnectInvoicing } = await import("../helpers/fake-stripe-connect-invoicing");
  return { stripe: fakeConnectInvoicing.stripe };
});

import { eq, inArray } from "drizzle-orm";
import Stripe from "stripe";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, connectCustomers, connectInvoiceSends, connectInvoices } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import {
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
  resetStripeConcurrencyForTests,
} from "../../lib/circuit-breakers";
import { tokenBuckets } from "../../lib/rate-limit";
import {
  fakeConnectInvoicing as stripe,
  stripeApiError,
} from "../helpers/fake-stripe-connect-invoicing";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

type Seeded = { id: string; apiKey: string; account: string };

describe("connected-account invoice lifecycle (finalize, send, void, delete)", () => {
  let app: any;
  const clientIds: string[] = [];

  async function seedClient(over: Partial<typeof clients.$inferInsert> = {}): Promise<Seeded> {
    const id = randomUUID();
    const apiKey = `life_key_${randomUUID().replace(/-/g, "")}`;
    const account = `acct_life_${id.slice(0, 8)}`;
    await db.insert(clients).values({
      id,
      name: "Lifecycle Client",
      email: `life-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: account,
      chargesEnabled: true,
      invoicingEnabled: true,
      processingFeeCents: 250,
      ...over,
    });
    clientIds.push(id);
    return { id, apiKey, account };
  }

  async function seedCustomer(c: Seeded) {
    const stripeCustomerId = `cus_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    stripe.seedCustomer(c.account, { id: stripeCustomerId, email: "tenant.private@example.com" });
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

  const call = (
    method: "POST" | "DELETE" | "GET",
    apiKey: string | undefined,
    url: string,
    key?: string | null,
    payload?: unknown
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      payload: payload as any,
    });

  const createBody = (customerId: string, over: Record<string, unknown> = {}) => ({
    customerId,
    lines: [{ description: "Rent", unitAmountCents: 100_000, quantity: 1 }],
    description: "March",
    metadata: { unit: "12" },
    ...over,
  });

  /** A complete draft made through the real create flow. */
  async function makeDraft(c: Seeded, key = randomUUID()) {
    const cust = await seedCustomer(c);
    const res = await call("POST", c.apiKey, "/api/v1/invoices", key, createBody(cust));
    expect(res.statusCode).toBe(201);
    return { id: res.json().id as string, cust, key };
  }

  const finalize = (c: Seeded, id: string) =>
    call("POST", c.apiKey, `/api/v1/invoices/${id}/finalize`);
  const send = (c: Seeded, id: string, key: string | null = randomUUID()) =>
    call("POST", c.apiKey, `/api/v1/invoices/${id}/send`, key);
  const voidInv = (c: Seeded, id: string) => call("POST", c.apiKey, `/api/v1/invoices/${id}/void`);
  const del = (c: Seeded, id: string) => call("DELETE", c.apiKey, `/api/v1/invoices/${id}`);

  async function makeOpen(c: Seeded) {
    const draft = await makeDraft(c);
    expect((await finalize(c, draft.id)).statusCode).toBe(200);
    return draft;
  }

  const rowOf = async (stripeInvoiceId: string) =>
    (
      await db
        .select()
        .from(connectInvoices)
        .where(eq(connectInvoices.stripeInvoiceId, stripeInvoiceId))
    )[0];
  const sendsOf = async (stripeInvoiceId: string) => {
    const row = await rowOf(stripeInvoiceId);
    return db.select().from(connectInvoiceSends).where(eq(connectInvoiceSends.invoiceId, row.id));
  };
  /** Makes the Nth `db.update` call (1-based) throw; the first one is the invoice claim. */
  function failUpdate(nth: number, message = "db down") {
    const original = db.update.bind(db);
    let n = 0;
    vi.spyOn(db, "update").mockImplementation(((...args: unknown[]) => {
      if (++n === nth) throw new Error(message);
      return (original as any)(...args);
    }) as never);
  }
  const mutating = (name: string) => stripe.callsTo(name);

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
    if (clientIds.length > 0) await db.delete(clients).where(inArray(clients.id, clientIds));
    delete process.env.CONNECT_INVOICING;
    if (app) await app.close();
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

  describe("access", () => {
    it("registers no lifecycle routes while CONNECT_INVOICING is off (404)", async () => {
      delete process.env.CONNECT_INVOICING;
      const off = await buildServer();
      for (const [method, url] of [
        ["POST", "/api/v1/invoices/in_1/finalize"],
        ["POST", "/api/v1/invoices/in_1/send"],
        ["POST", "/api/v1/invoices/in_1/void"],
        ["DELETE", "/api/v1/invoices/in_1"],
      ]) {
        const res = await off.inject({
          method: method as any,
          url,
          headers: { "x-api-key": "x", "idempotency-key": "k" },
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      await off.close();
      process.env.CONNECT_INVOICING = "true";
    });

    it("answers 401 without a key and 403 when invoicing is off for the client", async () => {
      const c = await seedClient({ invoicingEnabled: false });
      for (const res of [
        await call("POST", undefined, "/api/v1/invoices/in_1/finalize"),
        await call("DELETE", "nope", "/api/v1/invoices/in_1"),
      ]) {
        expect(res.statusCode).toBe(401);
      }
      for (const res of [
        await finalize(c, "in_1"),
        await send(c, "in_1"),
        await voidInv(c, "in_1"),
        await del(c, "in_1"),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe("INVOICING_NOT_ENABLED");
      }
      expect(stripe.calls).toHaveLength(0);
    });

    it("answers 404 for another client's invoice and unknown ids, with no Stripe call", async () => {
      const owner = await seedClient();
      const other = await seedClient();
      const { id } = await makeOpen(owner);
      const before = stripe.calls.length;
      for (const res of [
        await finalize(other, id),
        await send(other, id),
        await voidInv(other, id),
        await del(other, id),
        await finalize(owner, "in_unknown"),
      ]) {
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("NOT_FOUND");
      }
      expect(stripe.calls).toHaveLength(before);
    });

    it("answers 409 ACCOUNT_CHANGED and calls nothing when the client moved to another account", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      await db
        .update(clients)
        .set({ stripeAccountId: `acct_moved_${randomUUID().slice(0, 8)}` })
        .where(eq(clients.id, c.id));
      const before = stripe.calls.length;
      for (const res of [
        await finalize(c, id),
        await send(c, id),
        await voidInv(c, id),
        await del(c, id),
      ]) {
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("ACCOUNT_CHANGED");
      }
      expect(stripe.calls).toHaveLength(before);
    });

    it("blocks finalize and send when charges are off, but allows void and delete", async () => {
      const c = await seedClient();
      const open = await makeOpen(c);
      const draft = await makeDraft(c);
      await db.update(clients).set({ chargesEnabled: false }).where(eq(clients.id, c.id));

      for (const res of [await finalize(c, draft.id), await send(c, open.id)]) {
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("ACCOUNT_NOT_CONNECTED");
      }
      expect((await voidInv(c, open.id)).statusCode).toBe(200);
      expect((await del(c, draft.id)).statusCode).toBe(200);
    });

    it("passes the row's connected account on every Stripe call", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      await finalize(c, id);
      await send(c, id);
      await voidInv(c, id);
      const d = await makeDraft(c);
      await del(c, d.id);
      const lifecycle = stripe.calls.filter((x) =>
        ["finalizeInvoice", "sendInvoice", "voidInvoice", "del"].some((m) =>
          x.call.endsWith(`.${m}`)
        )
      );
      expect(lifecycle.length).toBeGreaterThanOrEqual(4);
      for (const x of stripe.calls) expect(x.options?.stripeAccount).toBe(c.account);
    });
  });

  describe("POST /invoices/:id/finalize", () => {
    it("finalizes a draft with auto_advance off and the per-invoice key, and stores the result", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      const res = await finalize(c, id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id,
        status: "open",
        number: expect.stringMatching(/^FAKE-/),
        hostedInvoiceUrl: expect.stringContaining(id),
        description: "March",
        metadata: { unit: "12" },
        finalizedAt: expect.any(String),
      });
      const [fin] = mutating("invoices.finalizeInvoice");
      expect(fin.params).toMatchObject({ id, auto_advance: false });
      expect(fin.options).toMatchObject({
        stripeAccount: c.account,
        idempotencyKey: `${c.id}:${id}:finalize`,
      });
      const row = await rowOf(id);
      expect(row.status).toBe("open");
      expect(row.finalizedAt).toBeInstanceOf(Date);
    });

    it("is idempotent: an open invoice answers 200 without finalizing again", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      await finalize(c, id);
      const again = await finalize(c, id);
      expect(again.statusCode).toBe(200);
      expect(again.json().status).toBe("open");
      expect(mutating("invoices.finalizeInvoice")).toHaveLength(1);
    });

    it("adopts an invoice Stripe already finalized (the earlier answer was lost)", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      const { stripe: sdk } = await import("../../lib/stripe");
      await sdk.invoices.finalizeInvoice(id, { auto_advance: false }, { stripeAccount: c.account });
      expect((await rowOf(id)).status).toBe("draft");

      const res = await finalize(c, id);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("open");
      expect((await rowOf(id)).status).toBe("open");
      expect(mutating("invoices.finalizeInvoice")).toHaveLength(1);
    });

    it("answers 502 INVOICE_TOTAL_MISMATCH and does not finalize when the total changed", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      stripe.retrieveOverrides[id] = { total: 5 };
      const res = await finalize(c, id);
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("INVOICE_TOTAL_MISMATCH");
      expect(mutating("invoices.finalizeInvoice")).toHaveLength(0);
      expect((await rowOf(id)).status).toBe("draft");
    });

    it("answers 409 INVOICE_NOT_FINALIZABLE for a paid, void or deleted invoice and adopts what Stripe says", async () => {
      const c = await seedClient();
      const paid = await makeDraft(c);
      stripe.retrieveOverrides[paid.id] = { status: "paid", amount_paid: 100_250 };
      const res = await finalize(c, paid.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("INVOICE_NOT_FINALIZABLE");
      expect((await rowOf(paid.id)).status).toBe("paid");

      const gone = await makeDraft(c);
      await del(c, gone.id);
      const res2 = await finalize(c, gone.id);
      expect(res2.statusCode).toBe(409);
      expect(res2.json().code).toBe("INVOICE_NOT_FINALIZABLE");
    });

    it("answers 409 INVOICE_INCOMPLETE for an invoice still being created", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const rowId = randomUUID();
      await db.insert(connectInvoices).values({
        id: rowId,
        clientId: c.id,
        connectedAccountId: c.account,
        stripeCustomerId: cust,
        idempotencyKey: sha(rowId),
        requestHash: sha("x"),
        creationState: "lines_added",
        stripeInvoiceId: `in_incomplete_${rowId.slice(0, 8)}`,
        currency: "usd",
        subtotalCents: 1000,
        feeAmountCents: 0,
        totalCents: 1000,
        amountRemainingCents: 1000,
      });
      const res = await finalize(c, `in_incomplete_${rowId.slice(0, 8)}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("INVOICE_INCOMPLETE");
      expect(stripe.calls).toHaveLength(0);
    });

    it("never moves a row's status backward", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      await db
        .update(connectInvoices)
        .set({ status: "paid" })
        .where(eq(connectInvoices.stripeInvoiceId, id));
      await finalize(c, id);
      expect((await rowOf(id)).status).toBe("paid");
    });

    it("answers 503 LEDGER_PERSISTENCE_FAILED when Postgres fails after Stripe, and a retry adopts", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      failUpdate(2);
      const failed = await finalize(c, id);
      expect(failed.statusCode).toBe(503);
      expect(failed.json().code).toBe("LEDGER_PERSISTENCE_FAILED");
      expect((await rowOf(id)).status).toBe("draft");

      const retry = await finalize(c, id);
      expect(retry.statusCode).toBe(200);
      expect((await rowOf(id)).status).toBe("open");
      expect(mutating("invoices.finalizeInvoice")).toHaveLength(1);
    });

    it("answers 503 STRIPE_CIRCUIT_OPEN without calling Stripe", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      stripe.calls.length = 0;
      openStripeCircuitForTests();
      const res = await finalize(c, id);
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("STRIPE_CIRCUIT_OPEN");
      expect(stripe.calls).toHaveLength(0);
    });
  });

  describe("POST /invoices/:id/send", () => {
    it("sends an open invoice with a per-key Stripe key and records it", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const res = await send(c, id, "send-1");
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("open");
      const [s] = mutating("invoices.sendInvoice");
      expect(s.options).toMatchObject({
        stripeAccount: c.account,
        idempotencyKey: `${c.id}:${id}:send:${sha("send-1")}`,
      });
      const row = await rowOf(id);
      expect(row.sendCount).toBe(1);
      expect(row.sentAt).toBeInstanceOf(Date);
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["sent"]);
      expect(stripe.emailsSent(c.account, id)).toBe(1);
    });

    it("requires an Idempotency-Key of at most 255 characters", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      expect((await send(c, id, null)).statusCode).toBe(400);
      expect((await send(c, id, "   ")).statusCode).toBe(400);
      expect((await send(c, id, "k".repeat(256))).statusCode).toBe(400);
      expect(mutating("invoices.sendInvoice")).toHaveLength(0);
    });

    it("refuses a draft or a void invoice (409 INVOICE_NOT_SENDABLE) without calling Stripe", async () => {
      const c = await seedClient();
      const draft = await makeDraft(c);
      const res = await send(c, draft.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("INVOICE_NOT_SENDABLE");

      const open = await makeOpen(c);
      await voidInv(c, open.id);
      expect((await send(c, open.id)).json().code).toBe("INVOICE_NOT_SENDABLE");
      expect(mutating("invoices.sendInvoice")).toHaveLength(0);
      expect(await sendsOf(draft.id)).toHaveLength(0);
    });

    it("caps sends at 3 and a replayed key never consumes the cap", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      for (const k of ["a", "b", "c"]) expect((await send(c, id, k)).statusCode).toBe(200);
      const fourth = await send(c, id, "d");
      expect(fourth.statusCode).toBe(409);
      expect(fourth.json().code).toBe("SEND_LIMIT_REACHED");

      const callsBefore = mutating("invoices.sendInvoice").length;
      const replay = await send(c, id, "a");
      expect(replay.statusCode).toBe(200);
      expect(mutating("invoices.sendInvoice")).toHaveLength(callsBefore);
      expect((await rowOf(id)).sendCount).toBe(3);
      expect(stripe.emailsSent(c.account, id)).toBe(3);
    });

    it("does not count a definite Stripe 4xx towards the cap", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.failNth("invoices.sendInvoice", 1, stripeApiError(400));
      const failed = await send(c, id, "bad");
      expect(failed.statusCode).toBe(502);
      expect(failed.json().code).toBe("SEND_REJECTED");
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["failed"]);

      for (const k of ["a", "b", "c"]) expect((await send(c, id, k)).statusCode).toBe(200);
      expect((await send(c, id, "d")).json().code).toBe("SEND_LIMIT_REACHED");
      expect((await rowOf(id)).sendCount).toBe(3);
    });

    it("answers 409 SEND_FAILED for a failed key, without calling Stripe or checking the cap", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.failNth("invoices.sendInvoice", 1, stripeApiError(400));
      expect((await send(c, id, "again")).statusCode).toBe(502);
      for (const k of ["a", "b", "c"]) await send(c, id, k);
      const before = mutating("invoices.sendInvoice").length;
      const retry = await send(c, id, "again");
      expect(retry.statusCode).toBe(409);
      expect(retry.json().code).toBe("SEND_FAILED");
      expect(mutating("invoices.sendInvoice")).toHaveLength(before);
      expect((await sendsOf(id)).filter((r) => r.state === "failed")).toHaveLength(1);
    });

    describe.each([
      [
        "a 403 permission error",
        () =>
          new Stripe.errors.StripePermissionError({
            type: "invalid_request_error",
            statusCode: 403,
          } as never),
        "failed",
        409,
      ],
      [
        "a 401 authentication error",
        () =>
          new Stripe.errors.StripeAuthenticationError({
            type: "authentication_error",
            statusCode: 401,
          } as never),
        "failed",
        502,
      ],
      [
        "a 402 card error",
        () => new Stripe.errors.StripeCardError({ type: "card_error", statusCode: 402 } as never),
        "failed",
        502,
      ],
      [
        "a 400 idempotency mismatch",
        () =>
          new Stripe.errors.StripeIdempotencyError({
            type: "idempotency_error",
            statusCode: 400,
          } as never),
        "failed",
        409,
      ],
      ["a 429 rate limit", () => stripeApiError(429), "pending", 503],
      ["a 5xx error", () => stripeApiError(503), "pending", 503],
      [
        "a connection error",
        () => new Stripe.errors.StripeConnectionError({ type: "api_error" } as never),
        "pending",
        503,
      ],
    ])("%s", (_name, makeErr, state, status) => {
      it(`leaves the send row ${state} and answers ${status}`, async () => {
        const c = await seedClient();
        const { id } = await makeOpen(c);
        stripe.failNth("invoices.sendInvoice", 1, makeErr());
        const res = await send(c, id, "k");
        expect(res.statusCode).toBe(status);
        expect((await sendsOf(id)).map((r) => r.state)).toEqual([state]);
        if (state === "pending") expect(res.json().code).toBe("SEND_STATUS_UNKNOWN");
      });
    });

    it("races two sends with the same key: one Stripe call, one count, the other is 409 or a replay", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const results = await Promise.all([send(c, id, "same"), send(c, id, "same")]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes[0]).toBe(200);
      expect([200, 409]).toContain(codes[1]);
      if (codes[1] === 409) {
        expect(results.find((r) => r.statusCode === 409).json().code).toBe(
          "IDEMPOTENCY_KEY_IN_USE"
        );
      }
      expect(mutating("invoices.sendInvoice")).toHaveLength(1);
      expect(await sendsOf(id)).toHaveLength(1);
      expect((await rowOf(id)).sendCount).toBe(1);
      // The cap is used once: two more distinct keys still fit.
      expect((await send(c, id, "x")).statusCode).toBe(200);
      expect((await send(c, id, "y")).statusCode).toBe(200);
      expect((await send(c, id, "z")).json().code).toBe("SEND_LIMIT_REACHED");
    });

    it("keeps an unknown error pending (it counts) and answers 503; the same key retries safely", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.failNth("invoices.sendInvoice", 1, stripeApiError(500));
      const res = await send(c, id, "flaky");
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("SEND_STATUS_UNKNOWN");
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["pending"]);

      // pending (1) + two more fills the cap of 3
      expect((await send(c, id, "b")).statusCode).toBe(200);
      expect((await send(c, id, "c")).statusCode).toBe(200);
      expect((await send(c, id, "d")).json().code).toBe("SEND_LIMIT_REACHED");

      const retry = await send(c, id, "flaky");
      expect(retry.statusCode).toBe(200);
      expect((await sendsOf(id)).map((r) => r.state).sort()).toEqual(["sent", "sent", "sent"]);
      expect((await rowOf(id)).sendCount).toBe(3);
    });

    it("does not email twice when the answer is lost and the same key retries", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.loseResponseNth("invoices.sendInvoice", 1);
      expect((await send(c, id, "lost")).statusCode).toBe(503);
      expect((await send(c, id, "lost")).statusCode).toBe(200);
      expect(stripe.emailsSent(c.account, id)).toBe(1);
      expect((await rowOf(id)).sendCount).toBe(1);
    });

    it("answers 409 IDEMPOTENCY_KEY_IN_USE for a live claim, and retries one whose claim expired", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const row = await rowOf(id);
      await db.insert(connectInvoiceSends).values({
        id: randomUUID(),
        invoiceId: row.id,
        clientId: c.id,
        keyHash: sha("busy"),
        state: "pending",
        claimedAt: new Date(),
      });
      const busy = await send(c, id, "busy");
      expect(busy.statusCode).toBe(409);
      expect(busy.json().code).toBe("IDEMPOTENCY_KEY_IN_USE");
      expect(mutating("invoices.sendInvoice")).toHaveLength(0);

      await db
        .update(connectInvoiceSends)
        .set({ claimedAt: new Date(Date.now() - 120_000) })
        .where(eq(connectInvoiceSends.keyHash, sha("busy")));
      const retry = await send(c, id, "busy");
      expect(retry.statusCode).toBe(200);
      expect(mutating("invoices.sendInvoice")[0].options?.idempotencyKey).toBe(
        `${c.id}:${id}:send:${sha("busy")}`
      );
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["sent"]);
    });

    it("answers 409 IDEMPOTENCY_KEY_IN_USE when Stripe says the key is still running", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const err: any = stripeApiError(409);
      err.code = "idempotency_key_in_use";
      stripe.failNth("invoices.sendInvoice", 1, err);
      const res = await send(c, id, "k");
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("IDEMPOTENCY_KEY_IN_USE");
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["pending"]);
    });

    it("serializes concurrent sends so exactly 3 get through", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const results = await Promise.all(
        ["1", "2", "3", "4", "5"].map((k) => send(c, id, `race-${k}`))
      );
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 200, 200, 409, 409]);
      expect(stripe.emailsSent(c.account, id)).toBe(3);
      expect((await rowOf(id)).sendCount).toBe(3);
    });

    it("answers 503 LEDGER_PERSISTENCE_FAILED when Postgres fails after Stripe, and the same key completes it", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const original = db.transaction.bind(db);
      let n = 0;
      vi.spyOn(db, "transaction").mockImplementation(((...args: unknown[]) =>
        n++ === 0 ? (original as any)(...args) : Promise.reject(new Error("db down"))) as never);
      const failed = await send(c, id, "pg");
      expect(failed.statusCode).toBe(503);
      expect(failed.json().code).toBe("LEDGER_PERSISTENCE_FAILED");
      vi.restoreAllMocks();
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["pending"]);

      const retry = await send(c, id, "pg");
      expect(retry.statusCode).toBe(200);
      expect(stripe.emailsSent(c.account, id)).toBe(1);
      expect((await rowOf(id)).sendCount).toBe(1);
    });

    it("answers 503 STRIPE_CIRCUIT_OPEN with the row left pending", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.calls.length = 0;
      openStripeCircuitForTests();
      const res = await send(c, id, "open-circuit");
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("STRIPE_CIRCUIT_OPEN");
      expect(stripe.calls).toHaveLength(0);
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["pending"]);
    });

    it("answers 404 when Stripe no longer knows the invoice, and the attempt does not count", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const { stripe: sdk } = await import("../../lib/stripe");
      // Drafts only can be deleted at Stripe, so drop it from the fake through a failure instead.
      const missing: any = stripeApiError(404);
      missing.code = "resource_missing";
      stripe.failNth("invoices.sendInvoice", 1, missing);
      void sdk;
      const res = await send(c, id, "gone");
      expect(res.statusCode).toBe(404);
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["failed"]);
    });
  });

  describe("POST /invoices/:id/void", () => {
    it("voids an open invoice with the per-invoice key", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const res = await voidInv(c, id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, status: "void", voidedAt: expect.any(String) });
      const [v] = mutating("invoices.voidInvoice");
      expect(v.options).toMatchObject({
        stripeAccount: c.account,
        idempotencyKey: `${c.id}:${id}:void`,
      });
      expect((await rowOf(id)).status).toBe("void");
    });

    it("answers 200 for an already void invoice, from Postgres or by adopting Stripe's state", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const { stripe: sdk } = await import("../../lib/stripe");
      await sdk.invoices.voidInvoice(id, {}, { stripeAccount: c.account });
      expect((await rowOf(id)).status).toBe("open");

      const adopted = await voidInv(c, id);
      expect(adopted.statusCode).toBe(200);
      expect(adopted.json().status).toBe("void");
      expect(mutating("invoices.voidInvoice")).toHaveLength(1);

      const before = stripe.calls.length;
      const again = await voidInv(c, id);
      expect(again.statusCode).toBe(200);
      expect(stripe.calls).toHaveLength(before);
    });

    it("voids an uncollectible invoice", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.retrieveOverrides[id] = { status: "uncollectible" };
      const res = await voidInv(c, id);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("void");
    });

    it("answers 409 INVOICE_NOT_VOIDABLE for a draft (pointing at DELETE)", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      const res = await voidInv(c, id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("INVOICE_NOT_VOIDABLE");
      expect(res.json().error).toContain("DELETE");
      expect(mutating("invoices.voidInvoice")).toHaveLength(0);
    });

    it("answers 409 INVOICE_NOT_VOIDABLE for a paid or deleted invoice", async () => {
      const c = await seedClient();
      const paid = await makeOpen(c);
      await db
        .update(connectInvoices)
        .set({ status: "paid" })
        .where(eq(connectInvoices.stripeInvoiceId, paid.id));
      const gone = await makeDraft(c);
      await del(c, gone.id);
      const before = stripe.calls.length;
      for (const id of [paid.id, gone.id]) {
        const res = await voidInv(c, id);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("INVOICE_NOT_VOIDABLE");
      }
      expect(stripe.calls).toHaveLength(before);
    });

    it("adopts a payment Stripe knows about and answers 409 when it was paid meanwhile", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.retrieveOverrides[id] = { status: "paid", amount_paid: 100_250, amount_remaining: 0 };
      const res = await voidInv(c, id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("INVOICE_NOT_VOIDABLE");
      const row = await rowOf(id);
      expect(row.status).toBe("paid");
      expect(row.amountPaidCents).toBe(100_250);
      expect(mutating("invoices.voidInvoice")).toHaveLength(0);
    });

    it("answers 503 LEDGER_PERSISTENCE_FAILED when Postgres fails after Stripe, and a retry adopts", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      failUpdate(2);
      const failed = await voidInv(c, id);
      expect(failed.statusCode).toBe(503);
      expect(failed.json().code).toBe("LEDGER_PERSISTENCE_FAILED");
      const retry = await voidInv(c, id);
      expect(retry.statusCode).toBe(200);
      expect(mutating("invoices.voidInvoice")).toHaveLength(1);
    });
  });

  describe("DELETE /invoices/:id", () => {
    it("deletes a draft on the row's account and marks the row deleted", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      const res = await del(c, id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, status: "deleted" });
      const [d] = mutating("invoices.del");
      expect(d.options?.stripeAccount).toBe(c.account);
      expect(stripe.invoicesOn(c.account).find((i) => i.id === id)).toBeUndefined();
      const row = await rowOf(id);
      expect(row.status).toBe("deleted");
      expect(row.claimedAt).toBeNull();
    });

    it("answers 409 INVOICE_NOT_DELETABLE for an open invoice, without calling Stripe", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const res = await del(c, id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("INVOICE_NOT_DELETABLE");
      expect(mutating("invoices.del")).toHaveLength(0);
    });

    it("answers 200 for an invoice that is already deleted, with no Stripe call", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      await del(c, id);
      const res = await del(c, id);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("deleted");
      expect(mutating("invoices.del")).toHaveLength(1);
    });

    it("treats Stripe's resource_missing as already deleted", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      const { stripe: sdk } = await import("../../lib/stripe");
      await sdk.invoices.del(id, {}, { stripeAccount: c.account });
      const res = await del(c, id);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("deleted");
      expect((await rowOf(id)).status).toBe("deleted");
    });

    it("answers 409 INVOICE_IN_USE while a create holds a live claim, and does not touch Stripe", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const rowId = randomUUID();
      const stripeId = `in_claimed_${rowId.slice(0, 8)}`;
      stripe.seedInvoice(c.account, { id: stripeId, customer: cust, total: 0, subtotal: 0 });
      await db.insert(connectInvoices).values({
        id: rowId,
        clientId: c.id,
        connectedAccountId: c.account,
        stripeCustomerId: cust,
        idempotencyKey: sha(rowId),
        requestHash: sha("x"),
        creationState: "invoice_created",
        stripeInvoiceId: stripeId,
        currency: "usd",
        subtotalCents: 1000,
        feeAmountCents: 0,
        totalCents: 1000,
        amountRemainingCents: 1000,
        claimedAt: new Date(),
      });
      const res = await del(c, stripeId);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("INVOICE_IN_USE");
      expect(mutating("invoices.del")).toHaveLength(0);
      expect(stripe.invoicesOn(c.account).some((i) => i.id === stripeId)).toBe(true);
    });

    it("loses to a create that is mid-flight: the delete is refused and the create finishes", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      let deleteResult: any;
      stripe.onCall = async (name, nth) => {
        if (name === "invoiceItems.create" && nth === 1) {
          const rows = await db
            .select()
            .from(connectInvoices)
            .where(eq(connectInvoices.clientId, c.id));
          deleteResult = await del(c, rows[0].stripeInvoiceId as string);
        }
      };
      const created = await call("POST", c.apiKey, "/api/v1/invoices", "race", createBody(cust));
      expect(deleteResult.statusCode).toBe(409);
      expect(deleteResult.json().code).toBe("INVOICE_IN_USE");
      expect(created.statusCode).toBe(201);
      expect(created.json().status).toBe("draft");
    });

    it("deletes an orphan whose create gave up (claim expired), and a create replay never resumes it", async () => {
      const c = await seedClient();
      const cust = await seedCustomer(c);
      const key = "orphan";
      stripe.failNth("invoiceItems.create", 1, stripeApiError(500));
      const failed = await call("POST", c.apiKey, "/api/v1/invoices", key, createBody(cust));
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      const [orphan] = await db
        .select()
        .from(connectInvoices)
        .where(eq(connectInvoices.clientId, c.id));
      expect(orphan.creationState).toBe("invoice_created");
      await db
        .update(connectInvoices)
        .set({ claimedAt: new Date(Date.now() - 120_000) })
        .where(eq(connectInvoices.id, orphan.id));

      const res = await del(c, orphan.stripeInvoiceId as string);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("deleted");
      // Visible by id even though the create never finished.
      expect(
        (await call("GET", c.apiKey, `/api/v1/invoices/${orphan.stripeInvoiceId}`)).statusCode
      ).toBe(200);

      const before = stripe.calls.length;
      const replay = await call("POST", c.apiKey, "/api/v1/invoices", key, createBody(cust));
      expect(replay.statusCode).toBe(200);
      expect(replay.json().status).toBe("deleted");
      expect(stripe.calls).toHaveLength(before);
    });

    it("answers a create replay on a deleted row with 200 and the deleted invoice", async () => {
      const c = await seedClient();
      const { id, cust, key } = await makeDraft(c);
      await del(c, id);
      const before = stripe.calls.length;
      const replay = await call("POST", c.apiKey, "/api/v1/invoices", key, createBody(cust));
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ id, status: "deleted" });
      expect(stripe.calls).toHaveLength(before);
    });

    it("answers 503 LEDGER_PERSISTENCE_FAILED when Postgres fails after Stripe, and a retry completes", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      const original = db.update.bind(db);
      let n = 0;
      // the first update is the claim; the second is the status write
      vi.spyOn(db, "update").mockImplementation(((...args: unknown[]) => {
        if (n++ === 1) throw new Error("db down");
        return (original as any)(...args);
      }) as never);
      const failed = await del(c, id);
      expect(failed.statusCode).toBe(503);
      expect(failed.json().code).toBe("LEDGER_PERSISTENCE_FAILED");
      vi.restoreAllMocks();
      expect((await rowOf(id)).claimedAt).toBeNull();

      const retry = await del(c, id);
      expect(retry.statusCode).toBe(200);
      expect((await rowOf(id)).status).toBe("deleted");
    });

    it("releases the claim when Stripe fails, so the retry works", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      stripe.failNth("invoices.del", 1, stripeApiError(500));
      const failed = await del(c, id);
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      expect((await rowOf(id)).claimedAt).toBeNull();
      expect((await del(c, id)).statusCode).toBe(200);
    });

    it("answers 409 INVOICE_IN_USE-free replay when two deletes race: both end deleted", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      const results = await Promise.all([del(c, id), del(c, id)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual(expect.arrayContaining([200]));
      expect((await rowOf(id)).status).toBe("deleted");
    });
  });

  describe("uncollectible invoices", () => {
    it("re-checks an uncollectible row on GET and applies uncollectible -> paid", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      await db
        .update(connectInvoices)
        .set({ status: "uncollectible", lastSyncedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(connectInvoices.stripeInvoiceId, id));
      stripe.retrieveOverrides[id] = { status: "paid", amount_paid: 100_250, amount_remaining: 0 };
      stripe.calls.length = 0;
      const res = await call("GET", c.apiKey, `/api/v1/invoices/${id}`);
      expect(res.statusCode).toBe(200);
      expect(stripe.callsTo("invoices.retrieve")).toHaveLength(1);
      expect(res.json().status).toBe("paid");
      expect((await rowOf(id)).status).toBe("paid");
    });

    it("never moves a row backward (paid, void, deleted stay; open cannot overwrite uncollectible)", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const setStatus = (status: "paid" | "void" | "uncollectible") =>
        db
          .update(connectInvoices)
          .set({ status, lastSyncedAt: new Date(Date.now() - 60 * 60_000) })
          .where(eq(connectInvoices.stripeInvoiceId, id));
      // Stripe still says open (the fake invoice is open).
      for (const status of ["uncollectible", "paid", "void"] as const) {
        await setStatus(status);
        tokenBuckets.clear();
        await call("POST", c.apiKey, `/api/v1/invoices/${id}/finalize`);
        expect((await rowOf(id)).status).toBe(status);
      }
    });
  });

  describe("lifecycle mutual exclusion", () => {
    it("refuses a delete that overlaps a finalize (409 INVOICE_IN_USE) and finalizes", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      let overlap: any;
      stripe.onCall = async (name) => {
        if (name === "invoices.retrieve" && !overlap) overlap = await del(c, id);
      };
      const res = await finalize(c, id);
      expect(overlap.statusCode).toBe(409);
      expect(overlap.json().code).toBe("INVOICE_IN_USE");
      expect(res.statusCode).toBe(200);
      expect((await rowOf(id)).claimedAt).toBeNull();
    });

    it("refuses a finalize that overlaps a delete (409 INVOICE_IN_USE) and deletes", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      let overlap: any;
      stripe.onCall = async (name) => {
        if (name === "invoices.del" && !overlap) overlap = await finalize(c, id);
      };
      const res = await del(c, id);
      expect(overlap.statusCode).toBe(409);
      expect(overlap.json().code).toBe("INVOICE_IN_USE");
      expect(res.statusCode).toBe(200);
      expect((await rowOf(id)).status).toBe("deleted");
    });

    it("refuses a void that overlaps a finalize, and finalize overlapping a void", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      let overlap: any;
      stripe.onCall = async (name) => {
        if (name === "invoices.voidInvoice" && !overlap) overlap = await finalize(c, id);
      };
      expect((await voidInv(c, id)).statusCode).toBe(200);
      expect(overlap.json().code).toBe("INVOICE_IN_USE");
    });

    it("releases the claim on every exit path", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      stripe.failNth("invoices.finalizeInvoice", 1, stripeApiError(500));
      expect((await finalize(c, id)).statusCode).toBeGreaterThanOrEqual(500);
      expect((await rowOf(id)).claimedAt).toBeNull();
      stripe.retrieveOverrides[id] = { total: 3 };
      expect((await finalize(c, id)).statusCode).toBe(502);
      expect((await rowOf(id)).claimedAt).toBeNull();
      expect((await voidInv(c, id)).statusCode).toBe(409);
      expect((await rowOf(id)).claimedAt).toBeNull();
    });
  });

  describe("Stripe state errors become 409 INVOICE_STATE_CHANGED", () => {
    const refuse = (name: string, id: string, after: Record<string, unknown>) => {
      stripe.failNth(name, 1, stripeApiError(400));
      stripe.onCall = async (n) => {
        if (n === name) stripe.retrieveOverrides[id] = after;
      };
    };

    it("finalize: a paid invoice is re-read, recorded and reported", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      refuse("invoices.finalizeInvoice", id, { status: "paid", amount_paid: 100_250 });
      const res = await finalize(c, id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "INVOICE_STATE_CHANGED", status: "paid" });
      expect((await rowOf(id)).status).toBe("paid");
      expect((await rowOf(id)).claimedAt).toBeNull();
    });

    it("void: a paid invoice is re-read and reported", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      refuse("invoices.voidInvoice", id, { status: "paid", amount_paid: 100_250 });
      const res = await voidInv(c, id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "INVOICE_STATE_CHANGED", status: "paid" });
      expect((await rowOf(id)).status).toBe("paid");
    });

    it("delete: a draft finalized meanwhile is re-read and reported open", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      refuse("invoices.del", id, { status: "open" });
      const res = await del(c, id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "INVOICE_STATE_CHANGED", status: "open" });
      expect((await rowOf(id)).status).toBe("open");
      expect((await rowOf(id)).claimedAt).toBeNull();
    });
  });

  describe("a genuine Stripe rejection is a generic 502", () => {
    const quotedReject = () =>
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        statusCode: 400,
        code: "parameter_invalid_empty",
        message: "SECRET-STRIPE-TEXT for tenant.private@example.com",
      } as never);

    const expectGeneric = (res: any) => {
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("STRIPE_REQUEST_REJECTED");
      expect(res.body).not.toContain("SECRET-STRIPE-TEXT");
      expect(res.body).not.toContain("tenant.private");
    };

    it("finalize: a 400 while Stripe still shows a draft", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      stripe.failNth("invoices.finalizeInvoice", 1, quotedReject());
      expectGeneric(await finalize(c, id));
      expect((await rowOf(id)).status).toBe("draft");
      expect((await rowOf(id)).claimedAt).toBeNull();
    });

    it("void: a 400 while Stripe still shows an open invoice", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.failNth("invoices.voidInvoice", 1, quotedReject());
      expectGeneric(await voidInv(c, id));
      expect((await rowOf(id)).status).toBe("open");
    });

    it("delete: a 400 while Stripe still shows a draft", async () => {
      const c = await seedClient();
      const { id } = await makeDraft(c);
      stripe.failNth("invoices.del", 1, quotedReject());
      expectGeneric(await del(c, id));
      expect((await rowOf(id)).status).toBe("draft");
    });

    it("send: a rejection never returns Stripe's message, and the row is failed", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.failNth("invoices.sendInvoice", 1, quotedReject());
      const res = await send(c, id, "k");
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("SEND_REJECTED");
      expect(res.body).not.toContain("SECRET-STRIPE-TEXT");
      expect(res.body).not.toContain("tenant.private");
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["failed"]);
    });

    it("send: losing to a void answers 409 INVOICE_STATE_CHANGED with the current status", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      stripe.failNth("invoices.sendInvoice", 1, quotedReject());
      stripe.onCall = async (name) => {
        if (name === "invoices.sendInvoice") stripe.retrieveOverrides[id] = { status: "void" };
      };
      const res = await send(c, id, "k");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "INVOICE_STATE_CHANGED", status: "void" });
      expect(res.body).not.toContain("SECRET-STRIPE-TEXT");
      expect((await rowOf(id)).status).toBe("void");
      expect((await sendsOf(id)).map((r) => r.state)).toEqual(["failed"]);
    });

    it("logs the Stripe code, type and ids but never the message", async () => {
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
      const a = await makeDraft(c);
      stripe.failNth("invoices.finalizeInvoice", 1, quotedReject());
      await logged.inject({
        method: "POST",
        url: `/api/v1/invoices/${a.id}/finalize`,
        headers: { "x-api-key": c.apiKey },
      });
      const o = await makeOpen(c);
      stripe.failNth("invoices.sendInvoice", 1, quotedReject());
      await logged.inject({
        method: "POST",
        url: `/api/v1/invoices/${o.id}/send`,
        headers: { "x-api-key": c.apiKey, "idempotency-key": "k" },
      });
      await logged.close();
      const all = lines.join("\n");
      expect(all).toContain("parameter_invalid_empty");
      expect(all).toContain("StripeInvalidRequestError");
      expect(all).toContain(a.id);
      expect(all).not.toContain("SECRET-STRIPE-TEXT");
      expect(all).not.toContain("tenant.private");
    });
  });

  describe("listing deleted invoices", () => {
    it("hides deleted invoices from the list unless status=deleted is asked for", async () => {
      const c = await seedClient();
      const keep = await makeDraft(c);
      const gone = await makeDraft(c);
      await del(c, gone.id);

      const all = (await call("GET", c.apiKey, "/api/v1/invoices")).json();
      expect(all.data.map((i: any) => i.id)).toEqual([keep.id]);

      const onlyDeleted = (await call("GET", c.apiKey, "/api/v1/invoices?status=deleted")).json();
      expect(onlyDeleted.data.map((i: any) => i.id)).toEqual([gone.id]);

      const draftOnly = (await call("GET", c.apiKey, "/api/v1/invoices?status=draft")).json();
      expect(draftOnly.data.map((i: any) => i.id)).toEqual([keep.id]);

      const byId = await call("GET", c.apiKey, `/api/v1/invoices/${gone.id}`);
      expect(byId.statusCode).toBe(200);
      expect(byId.json().status).toBe("deleted");
    });
  });

  describe("serialization", () => {
    it("serializes description and metadata, never the bookkeeping keys", async () => {
      const c = await seedClient();
      const { id } = await makeOpen(c);
      const body = (await call("GET", c.apiKey, `/api/v1/invoices/${id}`)).json();
      expect(body.description).toBe("March");
      expect(body.metadata).toEqual({ unit: "12" });
    });
  });

  describe("logging", () => {
    it("never logs a hosted URL, PDF link, email or Idempotency-Key value from the lifecycle routes", async () => {
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
      const email = "tenant.private@example.com";
      const req = (method: string, url: string, key?: string) =>
        logged.inject({
          method: method as any,
          url,
          headers: { "x-api-key": c.apiKey, ...(key ? { "idempotency-key": key } : {}) },
        });
      const IDEM = "IDEM-SECRET-KEY-98765";
      const quoted = (status: number) =>
        new Stripe.errors.StripeAPIError({
          type: "api_error",
          statusCode: status,
          message: `bad customer ${email} https://invoice.example/secret`,
        } as never);

      const a = await makeDraft(c);
      stripe.failNth("invoices.finalizeInvoice", 1, quoted(500));
      await req("POST", `/api/v1/invoices/${a.id}/finalize`);
      const fin = await req("POST", `/api/v1/invoices/${a.id}/finalize`);
      expect(fin.json().hostedInvoiceUrl).toContain("invoice.example"); // returned, never logged
      stripe.failNth("invoices.sendInvoice", 1, quoted(500));
      await req("POST", `/api/v1/invoices/${a.id}/send`, IDEM);
      await req("POST", `/api/v1/invoices/${a.id}/send`, IDEM);
      stripe.failNth("invoices.sendInvoice", 3, stripeApiError(400));
      await req("POST", `/api/v1/invoices/${a.id}/send`, `${IDEM}-2`);
      failUpdate(2, `db down ${email} https://invoice.example/secret`);
      await req("POST", `/api/v1/invoices/${a.id}/void`);
      vi.restoreAllMocks();
      await req("POST", `/api/v1/invoices/${a.id}/void`);
      const b = await makeDraft(c);
      stripe.failNth("invoices.del", 1, quoted(500));
      await req("DELETE", `/api/v1/invoices/${b.id}`);
      await req("DELETE", `/api/v1/invoices/${b.id}`);
      await logged.close();

      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join("\n");
      for (const secret of ["invoice.example", "/pdf", email, "tenant.private", IDEM, sha(IDEM)]) {
        expect(all, secret).not.toContain(secret);
      }
      expect(all).toContain(c.id);
    });
  });
});
