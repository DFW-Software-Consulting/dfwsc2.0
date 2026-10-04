import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
  },
}));

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, paymentLedger } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import { resetCircuitBreakersForTests } from "../../lib/circuit-breakers";
import {
  SESSION_STATUS_ANONYMOUS_RATE_LIMIT_MAX,
  SESSION_STATUS_API_KEY_RATE_LIMIT_MAX,
} from "../../lib/constants";

// GET /payments/session/:sessionId: anonymous (per-IP limit) or authenticated with X-Api-Key
// (higher per-client limit, scoped to the caller's own sessions).
describe("GET /payments/session/:sessionId authentication and limits", () => {
  let app: any;
  const clientIds: string[] = [];
  let clock = Date.parse("2026-11-01T09:00:00Z");

  type Building = { id: string; apiKey: string; sessionId: string };

  async function seedBuilding(status = "active"): Promise<Building> {
    const id = randomUUID();
    const apiKey = `status_key_${randomUUID().replace(/-/g, "")}`;
    await db.insert(clients).values({
      id,
      name: `Status Building ${id.slice(0, 6)}`,
      email: `status-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status,
      stripeAccountId: `acct_st_${id.slice(0, 8)}`,
      chargesEnabled: true,
    });
    clientIds.push(id);

    const suffix = randomUUID().replace(/-/g, "");
    const sessionId = `cs_test_${suffix}`;
    await db.insert(paymentLedger).values({
      id: randomUUID(),
      idempotencyKey: `idem_${suffix}`,
      connectedAccountId: `acct_st_${id.slice(0, 8)}`,
      stripeSessionId: sessionId,
      stripePaymentIntentId: null,
      clientId: id,
      source: "checkout",
      status: "paid",
      baseAmountCents: 150_000,
      totalAmountCents: 150_100,
      feeAmountCents: 100,
      currency: "usd",
    });
    return { id, apiKey, sessionId };
  }

  function getStatus(sessionId: string, apiKey?: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/payments/session/${sessionId}`,
      headers: apiKey === undefined ? {} : { "x-api-key": apiKey },
    });
  }

  beforeAll(async () => {
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
      await db.delete(paymentLedger).where(inArray(paymentLedger.clientId, clientIds));
      await db.delete(clients).where(inArray(clients.id, clientIds));
    }
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreakersForTests();
    // Freeze the clock so a limiter test is exact however long its requests take.
    // Each test starts ten minutes later, so no test sees another's hits in a one-minute window.
    clock += 10 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is configured for 30 anonymous and 600 authenticated requests per minute", () => {
    expect(SESSION_STATUS_ANONYMOUS_RATE_LIMIT_MAX).toBe(30);
    expect(SESSION_STATUS_API_KEY_RATE_LIMIT_MAX).toBe(600);
  });

  describe("anonymous", () => {
    it("still works without a key and returns the same payer-safe shape", async () => {
      const a = await seedBuilding();
      const response = await getStatus(a.sessionId);

      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual([
        "baseAmountCents",
        "createdAt",
        "currency",
        "feeAmountCents",
        "status",
        "totalAmountCents",
      ]);
      expect(response.json()).toMatchObject({
        status: "paid",
        baseAmountCents: 150_000,
        totalAmountCents: 150_100,
        feeAmountCents: 100,
        currency: "usd",
      });
    });

    it("can read any client's session, as before", async () => {
      const a = await seedBuilding();
      const b = await seedBuilding();
      expect((await getStatus(a.sessionId)).statusCode).toBe(200);
      expect((await getStatus(b.sessionId)).statusCode).toBe(200);
    });

    it("is limited to 30 a minute per IP, with Retry-After and RATE_LIMITED", async () => {
      const a = await seedBuilding();
      for (let i = 0; i < 30; i++) {
        expect((await getStatus(a.sessionId)).statusCode).toBe(200);
      }
      const refused = await getStatus(a.sessionId);
      expect(refused.statusCode).toBe(429);
      expect(refused.headers["retry-after"]).toBe("60");
      expect(refused.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
    });
  });

  describe("with an API key", () => {
    it("returns the caller's own session with the same shape", async () => {
      const a = await seedBuilding();
      const anonymous = await getStatus(a.sessionId);
      const authenticated = await getStatus(a.sessionId, a.apiKey);

      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json()).toEqual(anonymous.json());
    });

    it("answers another client's session exactly like an unknown session (404)", async () => {
      const a = await seedBuilding();
      const b = await seedBuilding();
      const unknownSession = `cs_test_${randomUUID().replace(/-/g, "")}`;

      const other = await getStatus(b.sessionId, a.apiKey);
      const unknown = await getStatus(unknownSession, a.apiKey);

      expect(other.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      const strip = ({ requestId: _requestId, ...rest }: Record<string, unknown>) => rest;
      expect(strip(other.json())).toEqual(strip(unknown.json()));
      expect(strip(other.json())).toEqual({
        error: "Payment session not found.",
        code: "NOT_FOUND",
      });
    });

    it("rejects an unknown key with 401 instead of falling back to anonymous", async () => {
      const a = await seedBuilding();
      const response = await getStatus(a.sessionId, "not-a-real-key");

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid API key." });
    });

    it("rejects a blank key with 401", async () => {
      const a = await seedBuilding();
      const response = await getStatus(a.sessionId, "");
      expect(response.statusCode).toBe(401);
    });

    it("rejects the key of an inactive client with 401", async () => {
      const inactive = await seedBuilding("inactive");
      const response = await getStatus(inactive.sessionId, inactive.apiKey);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid API key." });
    });

    it("does not run bcrypt for a key that matches no client", async () => {
      const compare = vi.spyOn(bcrypt, "compare");
      const a = await seedBuilding();
      for (let i = 0; i < 5; i++) {
        expect((await getStatus(a.sessionId, `guess-${i}`)).statusCode).toBe(401);
      }
      expect(compare).not.toHaveBeenCalled();
    });

    it("reuses the verification cache: bcrypt runs at most once for a repeatedly used key", async () => {
      const a = await seedBuilding();
      const compare = vi.spyOn(bcrypt, "compare");
      for (let i = 0; i < 10; i++) {
        expect((await getStatus(a.sessionId, a.apiKey)).statusCode).toBe(200);
      }
      expect(compare).toHaveBeenCalledTimes(1);
    });

    it("has its own limit of 600 a minute per client, with Retry-After and RATE_LIMITED", async () => {
      const a = await seedBuilding();
      const statuses: number[] = [];
      for (let wave = 0; wave < 12; wave++) {
        const responses = await Promise.all(
          Array.from({ length: 50 }, () => getStatus(a.sessionId, a.apiKey))
        );
        statuses.push(...responses.map((r: any) => r.statusCode));
      }
      expect(statuses).toHaveLength(600);
      expect(statuses.every((s) => s === 200)).toBe(true);

      const refused = await getStatus(a.sessionId, a.apiKey);
      expect(refused.statusCode).toBe(429);
      expect(refused.headers["retry-after"]).toBe("60");
      expect(refused.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
    }, 60_000);

    it("keeps authenticated and anonymous limits separate, and one client's limit apart from another's", async () => {
      const a = await seedBuilding();
      const b = await seedBuilding();

      // Far past the anonymous limit of 30, all authenticated: none refused.
      for (let i = 0; i < 100; i++) {
        expect((await getStatus(a.sessionId, a.apiKey)).statusCode).toBe(200);
      }
      // The anonymous per-IP budget is untouched by authenticated traffic.
      for (let i = 0; i < 30; i++) {
        expect((await getStatus(a.sessionId)).statusCode).toBe(200);
      }
      expect((await getStatus(a.sessionId)).statusCode).toBe(429);
      // Another client's key has its own bucket, and an exhausted anonymous IP does not block it.
      expect((await getStatus(b.sessionId, b.apiKey)).statusCode).toBe(200);
    }, 60_000);

    it("does not count a 401 against the anonymous limit or the client's limit", async () => {
      const a = await seedBuilding();
      for (let i = 0; i < 40; i++) {
        expect((await getStatus(a.sessionId, "wrong")).statusCode).toBe(401);
      }
      expect((await getStatus(a.sessionId)).statusCode).toBe(200);
      expect((await getStatus(a.sessionId, a.apiKey)).statusCode).toBe(200);
    });

    it("still validates the session id format for authenticated callers", async () => {
      const a = await seedBuilding();
      const response = await getStatus("not-a-session", a.apiKey);
      expect(response.statusCode).toBe(400);
    });
  });

  it("leaves the ledger untouched", async () => {
    const a = await seedBuilding();
    await getStatus(a.sessionId, a.apiKey);
    const rows = await db.select().from(paymentLedger).where(eq(paymentLedger.clientId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("paid");
  });
});
