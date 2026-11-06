import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeConnectInvoicing } = await import("../helpers/fake-stripe-connect-invoicing");
  return { stripe: fakeConnectInvoicing.stripe };
});

import { eq, inArray } from "drizzle-orm";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, connectCustomers } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import {
  configureStripeConcurrencyForTests,
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
  resetStripeConcurrencyForTests,
} from "../../lib/circuit-breakers";
import {
  INVOICE_WRITE_BUCKET_CAPACITY,
  INVOICE_WRITE_REFILL_PER_MINUTE,
} from "../../lib/constants";
import { tokenBuckets } from "../../lib/rate-limit";
import {
  ALLOWED_CONNECT_CALLS,
  fakeConnectInvoicing as stripe,
  stripeApiError,
} from "../helpers/fake-stripe-connect-invoicing";

const EMAIL = "tenant.private@example.com";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

describe("connected-account customers API (/api/v1/customers)", () => {
  let app: any;
  const clientIds: string[] = [];

  async function seedClient(over: Partial<typeof clients.$inferInsert> = {}) {
    const id = randomUUID();
    const apiKey = `cust_key_${randomUUID().replace(/-/g, "")}`;
    const account = `acct_cust_${id.slice(0, 8)}`;
    await db.insert(clients).values({
      id,
      name: "Customers Client",
      email: `cust-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: account,
      chargesEnabled: true,
      invoicingEnabled: true,
      ...over,
    });
    clientIds.push(id);
    return { id, apiKey, account };
  }

  const post = (apiKey: string | undefined, payload: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...(key === null ? {} : { "idempotency-key": key }),
      },
      payload: payload as any,
    });
  const get = (apiKey: string | undefined, url: string) =>
    app.inject({
      method: "GET",
      url,
      headers: apiKey ? { "x-api-key": apiKey } : {},
    });
  const patch = (apiKey: string, id: string, payload: unknown) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/customers/${id}`,
      headers: { "x-api-key": apiKey },
      payload: payload as any,
    });

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
    resetStripeConcurrencyForTests();
  });

  describe("registration and auth", () => {
    it("registers no routes unless CONNECT_INVOICING is exactly 'true' (404)", async () => {
      for (const value of [undefined, "false", "TRUE", "1", " true"]) {
        if (value === undefined) delete process.env.CONNECT_INVOICING;
        else process.env.CONNECT_INVOICING = value;
        const off = await buildServer();
        const res = await off.inject({
          method: "POST",
          url: "/api/v1/customers",
          headers: { "x-api-key": "whatever", "idempotency-key": "k" },
          payload: { email: EMAIL },
        });
        expect(res.statusCode, `value=${String(value)}`).toBe(404);
        await off.close();
      }
      process.env.CONNECT_INVOICING = "true";
    });

    it("answers 401 without a key or with a bad key", async () => {
      expect((await post(undefined, { email: EMAIL })).statusCode).toBe(401);
      expect((await post("nope", { email: EMAIL })).statusCode).toBe(401);
      expect((await get(undefined, "/api/v1/customers/cus_1")).statusCode).toBe(401);
      expect((await get("nope", "/api/v1/customers?externalRef=a")).statusCode).toBe(401);
      expect(stripe.calls).toHaveLength(0);
    });

    it("answers 403 INVOICING_NOT_ENABLED when the client flag is off, for reads and writes", async () => {
      const c = await seedClient({ invoicingEnabled: false });
      for (const res of [
        await post(c.apiKey, { email: EMAIL }),
        await get(c.apiKey, "/api/v1/customers/cus_1"),
        await get(c.apiKey, "/api/v1/customers?externalRef=a"),
        await patch(c.apiKey, "cus_1", { name: "x" }),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe("INVOICING_NOT_ENABLED");
      }
      expect(stripe.calls).toHaveLength(0);
    });

    it("answers 409 ACCOUNT_NOT_CONNECTED for writes when charges are off, while GET still works", async () => {
      const c = await seedClient();
      const created = await post(c.apiKey, { email: EMAIL, externalRef: "t-1" });
      expect(created.statusCode).toBe(201);
      await db.update(clients).set({ chargesEnabled: false }).where(eq(clients.id, c.id));

      const writeRes = await post(c.apiKey, { email: "other@example.com" });
      expect(writeRes.statusCode).toBe(409);
      expect(writeRes.json()).toEqual({
        error: "Client Stripe account is not connected or cannot accept charges.",
        code: "ACCOUNT_NOT_CONNECTED",
      });
      expect((await patch(c.apiKey, created.json().id, { name: "x" })).statusCode).toBe(409);
      expect((await get(c.apiKey, `/api/v1/customers/${created.json().id}`)).statusCode).toBe(200);
      expect((await get(c.apiKey, "/api/v1/customers?externalRef=t-1")).statusCode).toBe(200);
    });

    it("answers 409 ACCOUNT_NOT_CONNECTED when there is no Stripe account at all", async () => {
      const c = await seedClient({ stripeAccountId: null, chargesEnabled: false });
      expect((await post(c.apiKey, { email: EMAIL })).statusCode).toBe(409);
      const read = await get(c.apiKey, "/api/v1/customers/cus_1");
      expect(read.statusCode).toBe(409);
      expect(read.json().code).toBe("ACCOUNT_NOT_CONNECTED");
    });
  });

  describe("POST /customers", () => {
    it("creates a customer on the client's account and stores ids only", async () => {
      const c = await seedClient();
      const res = await post(c.apiKey, {
        email: EMAIL,
        name: "Tenant One",
        phone: "+15550001111",
        externalRef: "unit-12",
        metadata: { building: "A" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(
        ["createdAt", "email", "externalRef", "id", "name", "phone"].sort()
      );
      expect(body).toMatchObject({
        email: EMAIL,
        name: "Tenant One",
        phone: "+15550001111",
        externalRef: "unit-12",
      });

      const [create] = stripe.callsTo("customers.create");
      expect(create.params?.metadata).toEqual({
        building: "A",
        dfwsc_client_id: c.id,
        dfwsc_external_ref: "unit-12",
      });
      expect(create.options?.stripeAccount).toBe(c.account);

      const rows = await db
        .select()
        .from(connectCustomers)
        .where(eq(connectCustomers.clientId, c.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        stripeCustomerId: body.id,
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        connectedAccountId: c.account,
        externalRef: "unit-12",
      });
      // No PII anywhere in the stored row.
      expect(JSON.stringify(rows[0])).not.toContain("example.com");
      expect(JSON.stringify(rows[0])).not.toContain("Tenant");
    });

    it("namespaces the Stripe idempotency key per client", async () => {
      const c = await seedClient();
      await post(c.apiKey, { email: EMAIL }, "my-key");
      expect(stripe.callsTo("customers.create")[0].options?.idempotencyKey).toBe(
        `${c.id}:cust:${sha("my-key")}`
      );
    });

    it("replays the same Idempotency-Key with a single Stripe create", async () => {
      const c = await seedClient();
      const first = await post(c.apiKey, { email: EMAIL, externalRef: "r-1" }, "same");
      const second = await post(c.apiKey, { email: EMAIL, externalRef: "r-1" }, "same");
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(stripe.callsTo("customers.create")).toHaveLength(1);
      const rows = await db
        .select()
        .from(connectCustomers)
        .where(eq(connectCustomers.clientId, c.id));
      expect(rows).toHaveLength(1);
    });

    it("returns 409 CUSTOMER_EXISTS for a taken externalRef before any Stripe call", async () => {
      const c = await seedClient();
      const first = await post(c.apiKey, { email: EMAIL, externalRef: "dup" });
      stripe.calls.length = 0;
      const res = await post(c.apiKey, { email: "b@example.com", externalRef: "dup" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CUSTOMER_EXISTS", id: first.json().id });
      expect(stripe.calls).toHaveLength(0);
    });

    it("lets two clients use the same externalRef", async () => {
      const a = await seedClient();
      const b = await seedClient();
      expect((await post(a.apiKey, { email: EMAIL, externalRef: "shared" })).statusCode).toBe(201);
      expect((await post(b.apiKey, { email: EMAIL, externalRef: "shared" })).statusCode).toBe(201);
    });

    it("on an insert race deletes the orphan Stripe customer and answers CUSTOMER_EXISTS", async () => {
      const c = await seedClient();
      // A competing request records the same externalRef while this one is at Stripe.
      stripe.afterCreate = async () => {
        stripe.afterCreate = null;
        await db.insert(connectCustomers).values({
          id: randomUUID(),
          clientId: c.id,
          connectedAccountId: c.account,
          stripeCustomerId: "cus_winner",
          externalRef: "race",
          idempotencyKey: randomUUID(),
        });
      };
      const res = await post(c.apiKey, { email: EMAIL, externalRef: "race" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CUSTOMER_EXISTS", id: "cus_winner" });

      const [create] = stripe.callsTo("customers.create");
      const [del] = stripe.callsTo("customers.del");
      expect(del.params?.id).toMatch(/^cus_fake/);
      expect(del.options?.stripeAccount).toBe(c.account);
      expect(stripe.liveCustomers(c.account)).toHaveLength(0);
      expect(create).toBeDefined();
      const rows = await db
        .select()
        .from(connectCustomers)
        .where(eq(connectCustomers.clientId, c.id));
      expect(rows.map((r) => r.stripeCustomerId)).toEqual(["cus_winner"]);
    });

    it("still answers CUSTOMER_EXISTS when the orphan delete fails", async () => {
      const c = await seedClient();
      stripe.failNth("customers.del", 1, stripeApiError(500));
      stripe.afterCreate = async () => {
        stripe.afterCreate = null;
        await db.insert(connectCustomers).values({
          id: randomUUID(),
          clientId: c.id,
          connectedAccountId: c.account,
          stripeCustomerId: "cus_winner2",
          externalRef: "race2",
          idempotencyKey: randomUUID(),
        });
      };
      const res = await post(c.apiKey, { email: EMAIL, externalRef: "race2" });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("CUSTOMER_EXISTS");
    });

    it("does not delete anything when the same Idempotency-Key races itself", async () => {
      const c = await seedClient();
      let first: any;
      stripe.afterCreate = async (created) => {
        stripe.afterCreate = null;
        // The twin request already recorded the very customer this one just got from Stripe.
        await db.insert(connectCustomers).values({
          id: randomUUID(),
          clientId: c.id,
          connectedAccountId: c.account,
          stripeCustomerId: created.id,
          externalRef: null,
          idempotencyKey: sha("twin"),
        });
        first = created;
      };
      const res = await post(c.apiKey, { email: EMAIL }, "twin");
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(first.id);
      expect(stripe.callsTo("customers.del")).toHaveLength(0);
      expect(stripe.liveCustomers(c.account)).toHaveLength(1);
    });

    it("answers 503 on a non-unique insert failure; a retry re-adopts the same Stripe customer", async () => {
      const c = await seedClient();
      const spy = vi.spyOn(db, "insert").mockImplementationOnce(() => {
        throw new Error("db down");
      });
      const res = await post(c.apiKey, { email: EMAIL, externalRef: "p-1" }, "persist");
      spy.mockRestore();
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("CUSTOMER_PERSISTENCE_FAILED");
      expect(stripe.liveCustomers(c.account)).toHaveLength(1);

      const retry = await post(c.apiKey, { email: EMAIL, externalRef: "p-1" }, "persist");
      expect(retry.statusCode).toBe(201);
      const live = stripe.liveCustomers(c.account);
      expect(live).toHaveLength(1);
      expect(retry.json().id).toBe(live[0].id);
      expect(stripe.callsTo("customers.del")).toHaveLength(0);
      const rows = await db
        .select()
        .from(connectCustomers)
        .where(eq(connectCustomers.clientId, c.id));
      expect(rows).toHaveLength(1);
    });

    it("rejects a replayed Idempotency-Key whose body differs (409 IDEMPOTENCY_KEY_REUSED)", async () => {
      const c = await seedClient();
      const base = {
        email: "First@Example.com",
        name: "First",
        phone: "555",
        externalRef: "same-ref",
        metadata: { a: "1", b: "2" },
      };
      expect((await post(c.apiKey, base, "k-replay")).statusCode).toBe(201);
      // Same body, normalized: case/whitespace in email, reordered metadata.
      const same = await post(
        c.apiKey,
        { ...base, email: " first@example.com ", metadata: { b: "2", a: "1" } },
        "k-replay"
      );
      expect(same.statusCode).toBe(200);
      const variants = [
        { ...base, email: "other@example.com" },
        { ...base, externalRef: "other-ref" },
        { ...base, externalRef: undefined },
        { ...base, name: "Second" },
        { ...base, phone: undefined },
        { ...base, metadata: { a: "1" } },
        { ...base, metadata: { a: "1", b: "3" } },
        { ...base, metadata: { a: "1", b: "2", c: "3" } },
      ];
      for (const body of variants) {
        const res = await post(c.apiKey, body, "k-replay");
        expect(res.statusCode, JSON.stringify(body)).toBe(409);
        expect(res.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
      }
      expect(stripe.callsTo("customers.create")).toHaveLength(1);
    });

    it("treats absent, null-like and empty optional fields as equal on replay", async () => {
      const c = await seedClient();
      expect((await post(c.apiKey, { email: EMAIL }, "k-empty")).statusCode).toBe(201);
      const again = await post(c.apiKey, { email: EMAIL, name: "", phone: "" }, "k-empty");
      expect(again.statusCode).toBe(200);
    });

    it("does not spend a write token on a 400", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
      const c = await seedClient();
      expect((await post(c.apiKey, { email: "bad" })).statusCode).toBe(400);
      expect((await post(c.apiKey, { email: EMAIL }, null)).statusCode).toBe(400);
      expect((await patch(c.apiKey, "cus_1", {})).statusCode).toBe(400);
      expect(
        tokenBuckets.get(`ratelimit:bucket:POST:/api/v1/customers:stripe:${c.account}`)
      ).toBeUndefined();
    });

    it("refunds the token when the replay's Stripe read is refused by an open circuit", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
      const c = await seedClient();
      expect((await post(c.apiKey, { email: EMAIL }, "k-open")).statusCode).toBe(201);
      openStripeCircuitForTests();
      const res = await post(c.apiKey, { email: EMAIL }, "k-open");
      expect(res.statusCode).toBe(503);
      expect(
        tokenBuckets.get(`ratelimit:bucket:POST:/api/v1/customers:stripe:${c.account}`)?.tokens
      ).toBeCloseTo(INVOICE_WRITE_BUCKET_CAPACITY - 1, 0);
    });

    it("ignores unknown body fields on create and update, like POST /payments/create", async () => {
      const c = await seedClient();
      const res = await post(c.apiKey, { email: EMAIL, address: { line1: "x" } });
      expect(res.statusCode).toBe(201);
      expect(stripe.callsTo("customers.create")[0].params).not.toHaveProperty("address");
      const upd = await patch(c.apiKey, res.json().id, { name: "N", address: "x" });
      expect(upd.statusCode).toBe(200);
      expect(stripe.callsTo("customers.update")[0].params).toEqual({
        id: res.json().id,
        name: "N",
      });
    });

    it("does not delete a customer a stored row still references, and answers CUSTOMER_EXISTS", async () => {
      const c = await seedClient();
      stripe.afterCreate = async (created) => {
        stripe.afterCreate = null;
        // A different request recorded this very Stripe customer under the contested externalRef.
        await db.insert(connectCustomers).values({
          id: randomUUID(),
          clientId: c.id,
          connectedAccountId: c.account,
          stripeCustomerId: created.id,
          externalRef: "ref-shared",
          idempotencyKey: sha("someone-else"),
        });
      };
      const res = await post(c.apiKey, { email: EMAIL, externalRef: "ref-shared" });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("CUSTOMER_EXISTS");
      expect(stripe.callsTo("customers.del")).toHaveLength(0);
      expect(stripe.liveCustomers(c.account)).toHaveLength(1);
    });

    it("answers 503 (not CUSTOMER_EXISTS) and deletes nothing on an unrecognised unique violation", async () => {
      const c = await seedClient();
      stripe.afterCreate = async (created) => {
        stripe.afterCreate = null;
        // Same Stripe customer recorded under another key and no externalRef: neither a same-key
        // race nor an externalRef conflict.
        await db.insert(connectCustomers).values({
          id: randomUUID(),
          clientId: c.id,
          connectedAccountId: c.account,
          stripeCustomerId: created.id,
          externalRef: null,
          idempotencyKey: sha("another-key"),
        });
      };
      const res = await post(c.apiKey, { email: EMAIL }, "odd");
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("CUSTOMER_PERSISTENCE_FAILED");
      expect(stripe.callsTo("customers.del")).toHaveLength(0);
      expect(stripe.liveCustomers(c.account)).toHaveLength(1);
    });

    it("validates the request", async () => {
      const c = await seedClient();
      expect((await post(c.apiKey, { email: EMAIL }, null)).statusCode).toBe(400);
      expect((await post(c.apiKey, { email: EMAIL }, "   ")).statusCode).toBe(400);
      const longKey = "k".repeat(300);
      expect((await post(c.apiKey, { email: EMAIL }, longKey)).statusCode).toBe(400);
      expect((await post(c.apiKey, {})).statusCode).toBe(400);
      expect((await post(c.apiKey, { email: "not-an-email" })).statusCode).toBe(400);
      expect(
        (await post(c.apiKey, { email: EMAIL, externalRef: "x".repeat(101) })).statusCode
      ).toBe(400);
      expect((await post(c.apiKey, { email: EMAIL, externalRef: "" })).statusCode).toBe(400);
      expect((await post(c.apiKey, { email: EMAIL, phone: "1".repeat(21) })).statusCode).toBe(400);
      expect((await post(c.apiKey, { email: EMAIL, metadata: { a: 1 } })).statusCode).toBe(400);
      const tooMany = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`k${i}`, "v"]));
      // 49 user keys plus the two reserved ones exceed Stripe's 50.
      expect(
        (await post(c.apiKey, { email: EMAIL, externalRef: "meta-cap", metadata: tooMany }))
          .statusCode
      ).toBe(400);
      expect(stripe.calls).toHaveLength(0);
    });

    it("rejects user metadata keys starting with dfwsc_", async () => {
      const c = await seedClient();
      const res = await post(c.apiKey, { email: EMAIL, metadata: { dfwsc_client_id: "spoof" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("dfwsc_");
      expect(stripe.calls).toHaveLength(0);
    });

    it("maps Stripe errors", async () => {
      const c = await seedClient();
      stripe.failNth("customers.create", 1, stripeApiError(400));
      const invalid = await post(c.apiKey, { email: EMAIL });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe("INVALID_REQUEST");

      stripe.failNth("customers.create", 2, stripeApiError(429));
      const limited = await post(c.apiKey, { email: EMAIL });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().code).toBe("RATE_LIMITED");
      expect(limited.headers["retry-after"]).toBeDefined();

      stripe.failNth("customers.create", 3, stripeApiError(500));
      const down = await post(c.apiKey, { email: EMAIL });
      expect(down.statusCode).toBe(502);
      expect(down.json().code).toBe("STRIPE_FAILED");

      // Same Stripe key with other parameters: the permanent idempotency mismatch.
      expect((await post(c.apiKey, { email: EMAIL, name: "A" }, "reuse")).statusCode).toBe(201);
      await db.delete(connectCustomers).where(eq(connectCustomers.clientId, c.id));
      const reused = await post(c.apiKey, { email: EMAIL, name: "B" }, "reuse");
      expect(reused.statusCode).toBe(409);
      expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("answers 409 ACCOUNT_NOT_CONNECTED when Stripe refuses the account", async () => {
      const c = await seedClient();
      const { default: Stripe } = await import("stripe");
      stripe.failNth(
        "customers.create",
        1,
        new Stripe.errors.StripePermissionError({
          type: "invalid_request_error",
          statusCode: 403,
        } as never)
      );
      const res = await post(c.apiKey, { email: EMAIL });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ACCOUNT_NOT_CONNECTED");
    });
  });

  describe("GET and PATCH", () => {
    it("reads a customer by id and by externalRef as a sanitized object", async () => {
      const c = await seedClient();
      const created = (
        await post(c.apiKey, { email: EMAIL, name: "N", externalRef: "ext-9" })
      ).json();
      const byId = await get(c.apiKey, `/api/v1/customers/${created.id}`);
      const byRef = await get(c.apiKey, "/api/v1/customers?externalRef=ext-9");
      expect(byId.statusCode).toBe(200);
      expect(byRef.json()).toEqual(byId.json());
      expect(byId.json()).toEqual({
        id: created.id,
        email: EMAIL,
        name: "N",
        phone: null,
        externalRef: "ext-9",
        createdAt: created.createdAt,
      });
      // Raw Stripe fields (object, metadata) never leak.
      expect(byId.body).not.toContain("metadata");
      expect(byId.body).not.toContain("dfwsc_client_id");
    });

    it("answers 404 for unknown ids, unknown externalRef, and a Stripe-side deleted customer", async () => {
      const c = await seedClient();
      expect((await get(c.apiKey, "/api/v1/customers/cus_unknown")).statusCode).toBe(404);
      expect((await get(c.apiKey, "/api/v1/customers?externalRef=none")).statusCode).toBe(404);
      expect((await patch(c.apiKey, "cus_unknown", { name: "x" })).statusCode).toBe(404);

      const created = (await post(c.apiKey, { email: EMAIL })).json();
      await stripe.invoke("customers.del", [created.id, undefined, { stripeAccount: c.account }]);
      expect((await get(c.apiKey, `/api/v1/customers/${created.id}`)).statusCode).toBe(404);
      // A write to it is a 404 too (Stripe: resource_missing).
      expect((await patch(c.apiKey, created.id, { name: "x" })).statusCode).toBe(404);
    });

    it("requires the externalRef query parameter on the list route", async () => {
      const c = await seedClient();
      expect((await get(c.apiKey, "/api/v1/customers")).statusCode).toBe(400);
    });

    it("never shows another client's customer (404, no Stripe call)", async () => {
      const a = await seedClient();
      const b = await seedClient();
      const mine = (await post(a.apiKey, { email: EMAIL, externalRef: "mine" })).json();
      stripe.calls.length = 0;
      expect((await get(b.apiKey, `/api/v1/customers/${mine.id}`)).statusCode).toBe(404);
      expect((await get(b.apiKey, "/api/v1/customers?externalRef=mine")).statusCode).toBe(404);
      expect((await patch(b.apiKey, mine.id, { name: "hijack" })).statusCode).toBe(404);
      expect(stripe.calls).toHaveLength(0);
    });

    it("patches email, name and phone on the connected account", async () => {
      const c = await seedClient();
      const created = (await post(c.apiKey, { email: EMAIL, name: "Old" })).json();
      const res = await patch(c.apiKey, created.id, { name: "New", phone: "555" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: created.id, email: EMAIL, name: "New", phone: "555" });
      const [update] = stripe.callsTo("customers.update");
      expect(update.params).toEqual({ id: created.id, name: "New", phone: "555" });
      expect(update.options?.stripeAccount).toBe(c.account);
    });

    it("validates PATCH bodies", async () => {
      const c = await seedClient();
      const created = (await post(c.apiKey, { email: EMAIL })).json();
      expect((await patch(c.apiKey, created.id, {})).statusCode).toBe(400);
      expect((await patch(c.apiKey, created.id, { email: "bad" })).statusCode).toBe(400);
      expect((await patch(c.apiKey, created.id, { externalRef: "z" })).statusCode).toBe(400);
      expect(stripe.callsTo("customers.update")).toHaveLength(0);
    });

    it("has no delete route", async () => {
      const c = await seedClient();
      const created = (await post(c.apiKey, { email: EMAIL })).json();
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/customers/${created.id}`,
        headers: { "x-api-key": c.apiKey },
      });
      expect(res.statusCode).toBe(404);
    });

    it("maps Stripe failures on reads", async () => {
      const c = await seedClient();
      const created = (await post(c.apiKey, { email: EMAIL })).json();
      stripe.failNth("customers.retrieve", 1, stripeApiError(500));
      expect((await get(c.apiKey, `/api/v1/customers/${created.id}`)).statusCode).toBe(502);
      openStripeCircuitForTests();
      const open = await get(c.apiKey, `/api/v1/customers/${created.id}`);
      expect(open.statusCode).toBe(503);
      expect(open.json().code).toBe("STRIPE_CIRCUIT_OPEN");
    });
  });

  describe("connected-account guard", () => {
    it("every Stripe call carries stripeAccount equal to the client's account", async () => {
      const a = await seedClient();
      const b = await seedClient();
      for (const [c, ref] of [
        [a, "a1"],
        [b, "b1"],
      ] as const) {
        const created = (await post(c.apiKey, { email: EMAIL, externalRef: ref })).json();
        await post(c.apiKey, { email: EMAIL, externalRef: ref }, randomUUID()); // CUSTOMER_EXISTS
        await get(c.apiKey, `/api/v1/customers/${created.id}`);
        await get(c.apiKey, `/api/v1/customers?externalRef=${ref}`);
        await patch(c.apiKey, created.id, { name: "n" });
      }
      // The race path (create + orphan delete) as well.
      stripe.afterCreate = async () => {
        stripe.afterCreate = null;
        await db.insert(connectCustomers).values({
          id: randomUUID(),
          clientId: a.id,
          connectedAccountId: a.account,
          stripeCustomerId: "cus_w",
          externalRef: "guard-race",
          idempotencyKey: randomUUID(),
        });
      };
      await post(a.apiKey, { email: EMAIL, externalRef: "guard-race" });

      expect(stripe.calls.length).toBeGreaterThan(8);
      const accountsSeen = new Set<string>();
      for (const call of stripe.calls) {
        expect(ALLOWED_CONNECT_CALLS.has(call.call)).toBe(true);
        expect([a.account, b.account]).toContain(call.options?.stripeAccount);
        accountsSeen.add(call.options?.stripeAccount);
      }
      expect(accountsSeen).toEqual(new Set([a.account, b.account]));
      // And each client's objects live only on its own account.
      expect(stripe.liveCustomers(a.account).length).toBeGreaterThan(0);
      expect(stripe.liveCustomers(b.account)).toHaveLength(1);
    });
  });

  describe("rate limits", () => {
    it("configures the write bucket as 300 burst refilling 120 per minute", () => {
      expect(INVOICE_WRITE_BUCKET_CAPACITY).toBe(300);
      expect(INVOICE_WRITE_REFILL_PER_MINUTE).toBe(120);
    });

    const bucketKey = (account: string) =>
      `ratelimit:bucket:POST:/api/v1/customers:stripe:${account}`;

    it("charges one token per write, keyed by the connected account", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
      const c = await seedClient();
      await post(c.apiKey, { email: EMAIL });
      expect(tokenBuckets.get(bucketKey(c.account))?.tokens).toBe(
        INVOICE_WRITE_BUCKET_CAPACITY - 1
      );
    });

    it("refunds the token when the circuit is open (nothing reached Stripe)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
      const c = await seedClient();
      openStripeCircuitForTests();
      const res = await post(c.apiKey, { email: EMAIL });
      expect(res.statusCode).toBe(503);
      expect(stripe.calls).toHaveLength(0);
      expect(tokenBuckets.get(bucketKey(c.account))?.tokens).toBe(INVOICE_WRITE_BUCKET_CAPACITY);
    });

    it("refunds the token of a request that found Stripe busy, not of the one that ran", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
      const c = await seedClient();
      configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 50 });
      let release!: () => void;
      stripe.createGate = new Promise<void>((r) => {
        release = r;
      });
      const running = post(c.apiKey, { email: EMAIL });
      await vi.waitFor(() => expect(stripe.callsTo("customers.create")).toHaveLength(1));

      const busy = await post(c.apiKey, { email: "b@example.com" });
      expect(busy.statusCode).toBe(503);
      expect(busy.json().code).toBe("STRIPE_BUSY");
      expect(tokenBuckets.get(bucketKey(c.account))?.tokens).toBeCloseTo(
        INVOICE_WRITE_BUCKET_CAPACITY - 1,
        0
      );

      release();
      expect((await running).statusCode).toBe(201);
    });

    it("limits reads to 600 per minute per client with a 429", async () => {
      const c = await seedClient();
      const other = await seedClient();
      let last: any;
      for (let i = 0; i < 601; i++) {
        last = await get(c.apiKey, "/api/v1/customers/cus_none");
      }
      expect(last.statusCode).toBe(429);
      expect(last.headers["retry-after"]).toBeDefined();
      // Another client has its own budget.
      expect((await get(other.apiKey, "/api/v1/customers/cus_none")).statusCode).toBe(404);
    }, 60_000);
  });

  describe("logging", () => {
    it("never logs email, name or phone, including on failures", async () => {
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
      const send = (method: string, url: string, payload?: unknown, key?: string) =>
        logged.inject({
          method: method as any,
          url,
          headers: { "x-api-key": c.apiKey, ...(key ? { "idempotency-key": key } : {}) },
          payload: payload as any,
        });
      const secret = {
        email: "secret.person@example.com",
        name: "Secret Person",
        phone: "5559876",
      };
      const created = (
        await send("POST", "/api/v1/customers", { ...secret, externalRef: "log-1" }, "l1")
      ).json();
      stripe.failNth("customers.create", 2, stripeApiError(500));
      await send("POST", "/api/v1/customers", secret, "l2"); // Stripe failure
      stripe.afterCreate = async () => {
        stripe.afterCreate = null;
        await db.insert(connectCustomers).values({
          id: randomUUID(),
          clientId: c.id,
          connectedAccountId: c.account,
          stripeCustomerId: "cus_lw",
          externalRef: "log-race",
          idempotencyKey: randomUUID(),
        });
      };
      stripe.failNth("customers.del", 1, stripeApiError(500));
      await send("POST", "/api/v1/customers", { ...secret, externalRef: "log-race" }, "l3");
      stripe.failNth("customers.retrieve", 1, stripeApiError(500));
      await send("GET", `/api/v1/customers/${created.id}`);
      await send("PATCH", `/api/v1/customers/${created.id}`, { name: "Secret Person 2" });
      await logged.close();

      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join("\n");
      for (const pii of ["secret.person", "Secret Person", "5559876"]) {
        expect(all).not.toContain(pii);
      }
      expect(all).toContain(c.id);
    });
  });
});
