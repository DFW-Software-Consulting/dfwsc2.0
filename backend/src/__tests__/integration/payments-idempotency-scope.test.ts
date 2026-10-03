import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    paymentIntents: {
      create: vi.fn(),
      list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
    },
    checkout: {
      sessions: { create: vi.fn() },
    },
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
}));

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, paymentLedger } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import { stripe } from "../../lib/stripe";

const payload = {
  lineItems: [
    {
      price_data: {
        currency: "usd",
        product_data: { name: "Service" },
        unit_amount: 5000,
      },
      quantity: 1,
    },
  ],
};

type TestClient = { id: string; apiKey: string };

async function createClient(label: string): Promise<TestClient> {
  const id = randomUUID();
  const apiKey = randomUUID().replace(/-/g, "");
  await db.insert(clients).values({
    id,
    name: `Idempotency ${label}`,
    email: `idem-${id}@example.com`,
    apiKeyHash: await hashApiKey(apiKey),
    apiKeyLookup: sha256Lookup(apiKey),
    status: "active",
    stripeAccountId: `acct_idem${id.replace(/-/g, "").slice(0, 12)}`,
    chargesEnabled: true,
    processingFeeCents: 0,
  });
  return { id, apiKey };
}

function sessionFor(id: string) {
  return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
}

describe("POST /api/v1/payments/create — idempotency keys are scoped per client", () => {
  let app: any;
  const created: TestClient[] = [];
  const sessionIds: string[] = [];

  function newSessionId() {
    const id = `cs_test_${randomUUID().replace(/-/g, "")}`;
    sessionIds.push(id);
    return id;
  }

  function createPayment(client: TestClient, key: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": client.apiKey,
        "idempotency-key": key,
        "content-type": "application/json",
      },
      payload,
    });
  }

  beforeAll(async () => {
    process.env.FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.mocked(stripe.checkout.sessions.create).mockReset();
  });

  afterEach(async () => {
    if (created.length > 0) {
      await db.delete(clients).where(
        inArray(
          clients.id,
          created.map((c) => c.id)
        )
      );
    }
    created.length = 0;
    sessionIds.length = 0;
  });

  async function newClient(label: string) {
    const client = await createClient(label);
    created.push(client);
    return client;
  }

  it("lets two clients use the same key, each with its own ledger row and namespaced Stripe key", async () => {
    const a = await newClient("A");
    const b = await newClient("B");
    const sessionA = newSessionId();
    const sessionB = newSessionId();
    vi.mocked(stripe.checkout.sessions.create)
      .mockResolvedValueOnce(sessionFor(sessionA) as any)
      .mockResolvedValueOnce(sessionFor(sessionB) as any);

    const resA = await createPayment(a, "invoice-1001");
    const resB = await createPayment(b, "invoice-1001");

    expect(resA.statusCode).toBe(201);
    expect(resB.statusCode).toBe(201);
    expect(resA.json().sessionId).toBe(sessionA);
    expect(resB.json().sessionId).toBe(sessionB);

    const stripeKeys = vi
      .mocked(stripe.checkout.sessions.create)
      .mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey);
    expect(stripeKeys).toEqual([`${a.id}:invoice-1001`, `${b.id}:invoice-1001`]);

    const [rowA] = await db
      .select()
      .from(paymentLedger)
      .where(eq(paymentLedger.stripeSessionId, sessionA));
    const [rowB] = await db
      .select()
      .from(paymentLedger)
      .where(eq(paymentLedger.stripeSessionId, sessionB));
    expect(rowA?.clientId).toBe(a.id);
    expect(rowA?.idempotencyKey).toBe("invoice-1001");
    expect(rowB?.clientId).toBe(b.id);
    expect(rowB?.idempotencyKey).toBe("invoice-1001");
  });

  it("returns the same session for a genuine retry from the same client", async () => {
    const a = await newClient("retry");
    const session = newSessionId();
    // Stripe replays the original session for a repeated key.
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue(sessionFor(session) as any);

    const first = await createPayment(a, "retry-key");
    const second = await createPayment(a, "retry-key");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.json().sessionId).toBe(session);

    const rows = await db.select().from(paymentLedger).where(eq(paymentLedger.clientId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stripeSessionId).toBe(session);
  });

  it("returns 409 IDEMPOTENCY_KEY_REUSED when a key is reused for a different session", async () => {
    const a = await newClient("reuse");
    const original = newSessionId();
    const replacement = newSessionId();
    vi.mocked(stripe.checkout.sessions.create)
      .mockResolvedValueOnce(sessionFor(original) as any)
      // Stripe pruned the key (or it was otherwise forgotten) and made a new session.
      .mockResolvedValueOnce(sessionFor(replacement) as any);

    const first = await createPayment(a, "reused-key");
    const second = await createPayment(a, "reused-key");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(second.json().sessionId).toBeUndefined();
    expect(second.json().url).toBeUndefined();

    const rows = await db.select().from(paymentLedger).where(eq(paymentLedger.clientId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stripeSessionId).toBe(original);
  });

  it("returns 503 and no url when the session already belongs to another client's row", async () => {
    const a = await newClient("conflict-A");
    const b = await newClient("conflict-B");
    const shared = newSessionId();
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue(sessionFor(shared) as any);

    const first = await createPayment(a, "k1");
    const second = await createPayment(b, "k2");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(503);
    expect(second.json().code).toBe("LEDGER_PERSISTENCE_FAILED");
    expect(second.json().url).toBeUndefined();
    expect(second.json().sessionId).toBeUndefined();

    const rows = await db
      .select()
      .from(paymentLedger)
      .where(eq(paymentLedger.stripeSessionId, shared));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientId).toBe(a.id);
    expect(rows[0]?.idempotencyKey).toBe("k1");
  });

  it("accepts the longest key that fits Stripe's 255-character limit once namespaced", async () => {
    const a = await newClient("boundary-ok");
    const session = newSessionId();
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue(sessionFor(session) as any);
    const key = "k".repeat(255 - a.id.length - 1);

    const res = await createPayment(a, key);

    expect(res.statusCode).toBe(201);
    const stripeKey = (
      vi.mocked(stripe.checkout.sessions.create).mock.calls[0]?.[1] as {
        idempotencyKey: string;
      }
    ).idempotencyKey;
    expect(stripeKey).toHaveLength(255);
  });

  it("rejects a key one character over the namespaced limit without calling Stripe", async () => {
    const a = await newClient("boundary-over");
    const key = "k".repeat(255 - a.id.length);

    const res = await createPayment(a, key);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(`${255 - a.id.length - 1} characters`);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects keys too long to namespace under 255 characters", async () => {
    const a = await newClient("long");
    const res = await createPayment(a, "k".repeat(255));
    expect(res.statusCode).toBe(400);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});
