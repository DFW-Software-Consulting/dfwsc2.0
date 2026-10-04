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
  SESSION_STATUS_FAILED_AUTH_RATE_LIMIT_MAX,
} from "../../lib/constants";
import { makeAdminToken } from "../helpers/auth";

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

  it("allows 30 failed key authentications a minute per IP", () => {
    expect(SESSION_STATUS_FAILED_AUTH_RATE_LIMIT_MAX).toBe(30);
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
      // Verify the key first: once the IP is at its failed-auth budget (30 distinct failing
      // keys), only a recently verified key still gets through (see "failed key authentications").
      expect((await getStatus(a.sessionId, a.apiKey)).statusCode).toBe(200);
      for (let i = 0; i < SESSION_STATUS_FAILED_AUTH_RATE_LIMIT_MAX; i++) {
        expect((await getStatus(a.sessionId, `wrong-${i}`)).statusCode).toBe(401);
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

  describe("failed key authentications", () => {
    const BUDGET = SESSION_STATUS_FAILED_AUTH_RATE_LIMIT_MAX;

    async function exhaustBudget(sessionId: string) {
      for (let i = 0; i < BUDGET; i++) {
        expect((await getStatus(sessionId, `junk-${i}`)).statusCode).toBe(401);
      }
    }

    it("turns a flood of junk keys from one IP into 429 with no further database lookups", async () => {
      const a = await seedBuilding();
      await exhaustBudget(a.sessionId);

      const select = vi.spyOn(db, "select");
      for (let i = 0; i < 20; i++) {
        const refused = await getStatus(a.sessionId, `more-junk-${i}`);
        expect(refused.statusCode).toBe(429);
        expect(refused.headers["retry-after"]).toBe("60");
        expect(refused.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
      }
      expect(select).not.toHaveBeenCalled();
    });

    it("refuses over-budget requests before the lookup even when the key is a real, uncached one", async () => {
      const a = await seedBuilding();
      await exhaustBudget(a.sessionId);

      const select = vi.spyOn(db, "select");
      const refused = await getStatus(a.sessionId, a.apiKey);
      expect(refused.statusCode).toBe(429);
      expect(select).not.toHaveBeenCalled();
    });

    it("reports Retry-After as the time until the oldest failure leaves the window", async () => {
      const a = await seedBuilding();
      await exhaustBudget(a.sessionId);

      vi.setSystemTime(clock + 20_000);
      const refused = await getStatus(a.sessionId, "junk-late");
      expect(refused.statusCode).toBe(429);
      expect(refused.headers["retry-after"]).toBe("40");
    });

    it("does not charge refusals, so the window drains and junk keys get 401 again", async () => {
      const a = await seedBuilding();
      await exhaustBudget(a.sessionId);
      for (let i = 0; i < 10; i++) {
        expect((await getStatus(a.sessionId, "junk-again")).statusCode).toBe(429);
      }

      vi.setSystemTime(clock + 60_001);
      expect((await getStatus(a.sessionId, "junk-after-window")).statusCode).toBe(401);
    });

    it("never charges successful authentications", async () => {
      const a = await seedBuilding();
      for (let i = 0; i < BUDGET * 3; i++) {
        expect((await getStatus(a.sessionId, a.apiKey)).statusCode).toBe(200);
      }
      // The whole failed-auth budget is still available afterwards.
      await exhaustBudget(a.sessionId);
      expect((await getStatus(a.sessionId, "junk-over")).statusCode).toBe(429);
    });

    it("does not charge a valid key that merely asks for a missing session (404) or a bad id (400)", async () => {
      const a = await seedBuilding();
      const unknown = `cs_test_${randomUUID().replace(/-/g, "")}`;
      for (let i = 0; i < BUDGET; i++) {
        expect((await getStatus(unknown, a.apiKey)).statusCode).toBe(404);
        expect((await getStatus("bad-id", a.apiKey)).statusCode).toBe(400);
      }
      await exhaustBudget(a.sessionId);
    });

    it("lets a recently verified valid key through while the IP is over budget", async () => {
      const a = await seedBuilding();
      // Verified once (cached), then a misconfigured key from the same IP burns the budget.
      expect((await getStatus(a.sessionId, a.apiKey)).statusCode).toBe(200);
      await exhaustBudget(a.sessionId);
      expect((await getStatus(a.sessionId, "junk-over")).statusCode).toBe(429);

      const served = await getStatus(a.sessionId, a.apiKey);
      expect(served.statusCode).toBe(200);
      expect(served.json().status).toBe("paid");
    });

    it("still refuses a valid key that has not been verified recently while over budget", async () => {
      const verified = await seedBuilding();
      const cold = await seedBuilding();
      expect((await getStatus(verified.sessionId, verified.apiKey)).statusCode).toBe(200);
      await exhaustBudget(verified.sessionId);

      expect((await getStatus(cold.sessionId, cold.apiKey)).statusCode).toBe(429);
    });

    it("rejects a cached key whose client has since been deactivated", async () => {
      const a = await seedBuilding();
      expect((await getStatus(a.sessionId, a.apiKey)).statusCode).toBe(200);
      await exhaustBudget(a.sessionId);

      await db.update(clients).set({ status: "inactive" }).where(eq(clients.id, a.id));
      const response = await getStatus(a.sessionId, a.apiKey);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid API key." });
    });

    it("leaves anonymous requests from an over-budget IP unchanged", async () => {
      const a = await seedBuilding();
      await exhaustBudget(a.sessionId);
      expect((await getStatus(a.sessionId, "junk-over")).statusCode).toBe(429);

      for (let i = 0; i < SESSION_STATUS_ANONYMOUS_RATE_LIMIT_MAX; i++) {
        expect((await getStatus(a.sessionId)).statusCode).toBe(200);
      }
      const refused = await getStatus(a.sessionId);
      expect(refused.statusCode).toBe(429);
      expect(refused.headers["retry-after"]).toBe("60");
    });

    it("200 concurrent requests with 200 different junk keys do at most the budget in lookups", async () => {
      const a = await seedBuilding();
      const select = vi.spyOn(db, "select");

      const responses = await Promise.all(
        Array.from({ length: 200 }, (_, i) => getStatus(a.sessionId, `flood-${i}`))
      );

      const statuses = responses.map((r: any) => r.statusCode);
      expect(select.mock.calls.length).toBeLessThanOrEqual(BUDGET);
      expect(statuses.filter((c: number) => c === 401)).toHaveLength(BUDGET);
      expect(statuses.filter((c: number) => c === 429)).toHaveLength(200 - BUDGET);
    });

    it("200 concurrent requests with the same junk key do at most one lookup", async () => {
      const a = await seedBuilding();
      const select = vi.spyOn(db, "select");

      const responses = await Promise.all(
        Array.from({ length: 200 }, () => getStatus(a.sessionId, "the-same-junk-key"))
      );

      expect(select.mock.calls.length).toBeLessThanOrEqual(1);
      expect(responses.every((r: any) => r.statusCode === 401)).toBe(true);
    });

    it("a mix of junk and valid keys never costs more junk lookups than the budget", async () => {
      const buildings = await Promise.all(Array.from({ length: 5 }, () => seedBuilding()));
      const select = vi.spyOn(db, "select");
      const isValid = (i: number) => i % 30 === 0;

      const responses = await Promise.all(
        Array.from({ length: 150 }, (_, i) =>
          isValid(i)
            ? getStatus(buildings[i / 30].sessionId, buildings[i / 30].apiKey)
            : getStatus(buildings[0].sessionId, `mixed-${i % 40}`)
        )
      );

      // A served valid key is two selects (the key lookup and the ledger row); everything else
      // that reached the database was a junk key, once however often it was sent.
      const served = responses.filter((r: any, i) => isValid(i) && r.statusCode === 200).length;
      expect(select.mock.calls.length - served * 2).toBeLessThanOrEqual(BUDGET);
      expect(responses.some((r: any, i) => !isValid(i) && r.statusCode === 401)).toBe(true);
    });

    it("one bad key sent 100 times uses one unit, so another key from the same IP is served", async () => {
      const a = await seedBuilding();
      const b = await seedBuilding();
      for (let i = 0; i < 100; i++) {
        expect((await getStatus(a.sessionId, "stale-rotated-key")).statusCode).toBe(401);
      }

      // b's key has never been verified (not in the cache) and is served.
      const served = await getStatus(b.sessionId, b.apiKey);
      expect(served.statusCode).toBe(200);
      // Only one unit was used: BUDGET - 1 more distinct junk keys still get their own 401.
      for (let i = 0; i < BUDGET - 1; i++) {
        expect((await getStatus(a.sessionId, `junk-${i}`)).statusCode).toBe(401);
      }
      expect((await getStatus(a.sessionId, "junk-over")).statusCode).toBe(429);
    });

    it("repeats of a bad key do no further lookups", async () => {
      const a = await seedBuilding();
      expect((await getStatus(a.sessionId, "stale-key")).statusCode).toBe(401);

      const select = vi.spyOn(db, "select");
      for (let i = 0; i < 20; i++) {
        expect((await getStatus(a.sessionId, "stale-key")).statusCode).toBe(401);
      }
      expect(select).not.toHaveBeenCalled();
    });

    it("20 concurrent requests with the same valid, uncached key all succeed", async () => {
      const a = await seedBuilding();

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => getStatus(a.sessionId, a.apiKey))
      );

      expect(responses.map((r: any) => r.statusCode)).toEqual(Array(20).fill(200));
      // Nothing was charged: the whole budget is still available.
      await exhaustBudget(a.sessionId);
    });

    it("serves many different uncached valid keys at once, more than the budget, none refused", async () => {
      const buildings = await Promise.all(
        Array.from({ length: BUDGET + 10 }, () => seedBuilding())
      );

      const responses = await Promise.all(buildings.map((b) => getStatus(b.sessionId, b.apiKey)));

      expect(responses.map((r: any) => r.statusCode)).toEqual(Array(buildings.length).fill(200));
    }, 60_000);

    it("a deactivated client stays 401 on every repeat", async () => {
      const inactive = await seedBuilding("inactive");
      for (let i = 0; i < 5; i++) {
        const response = await getStatus(inactive.sessionId, inactive.apiKey);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: "Invalid API key." });
      }
    });

    it("a reactivated client works again once the known-bad record expires (60 seconds)", async () => {
      const client = await seedBuilding("inactive");
      expect((await getStatus(client.sessionId, client.apiKey)).statusCode).toBe(401);

      await db.update(clients).set({ status: "active" }).where(eq(clients.id, client.id));
      expect((await getStatus(client.sessionId, client.apiKey)).statusCode).toBe(401);

      vi.setSystemTime(clock + 60_001);
      expect((await getStatus(client.sessionId, client.apiKey)).statusCode).toBe(200);
    });

    it("a client reactivated by an admin works again immediately", async () => {
      const client = await seedBuilding("inactive");
      expect((await getStatus(client.sessionId, client.apiKey)).statusCode).toBe(401);

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${client.id}`,
        headers: { authorization: `Bearer ${makeAdminToken(process.env.JWT_SECRET)}` },
        payload: { status: "active" },
      });
      expect(patched.statusCode).toBe(200);

      expect((await getStatus(client.sessionId, client.apiKey)).statusCode).toBe(200);
    });

    it("a database error during verification is a 500 and is never charged", async () => {
      const a = await seedBuilding();
      const select = vi.spyOn(db, "select").mockImplementation(() => {
        throw new Error("connection reset");
      });
      for (let i = 0; i < BUDGET + 5; i++) {
        expect((await getStatus(a.sessionId, `erroring-${i}`)).statusCode).toBe(500);
      }
      select.mockRestore();

      // The budget is intact, and the keys that errored were not remembered as bad.
      await exhaustBudget(a.sessionId);
      expect((await getStatus(a.sessionId, "junk-over")).statusCode).toBe(429);
    });

    it("does not charge anonymous requests to the failed-auth budget", async () => {
      const a = await seedBuilding();
      for (let i = 0; i < SESSION_STATUS_ANONYMOUS_RATE_LIMIT_MAX; i++) {
        await getStatus(a.sessionId);
      }
      // Anonymous budget is gone, but a junk key still gets its own 401 rather than a 429.
      expect((await getStatus(a.sessionId, "junk")).statusCode).toBe(401);
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
