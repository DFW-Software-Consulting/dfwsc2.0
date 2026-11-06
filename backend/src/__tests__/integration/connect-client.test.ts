import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn(), retrieve: vi.fn(), del: vi.fn(), createLoginLink: vi.fn() },
    accountLinks: { create: vi.fn() },
  },
}));

import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import { resetCircuitBreakersForTests } from "../../lib/circuit-breakers";
import { hitBuckets } from "../../lib/rate-limit";
import { stripe } from "../../lib/stripe";

const ORIGIN = "https://app.client-example.com";
const RETURN_URL = `${ORIGIN}/settings/payments?done=1`;
const REFRESH_URL = `${ORIGIN}/settings/payments?refresh=1`;
const LINK_URL = "https://connect.stripe.com/setup/e/acct_x/SECRETTOKEN";

describe("client-facing Connect routes", () => {
  let app: any;
  const clientIds: string[] = [];

  async function seedClient(
    opts: {
      status?: "active" | "inactive";
      stripeAccountId?: string | null;
      origins?: string[];
      detailsSubmitted?: boolean;
    } = {}
  ) {
    const id = randomUUID();
    const apiKey = randomUUID().replace(/-/g, "");
    await db.insert(clients).values({
      id,
      name: "Connect Client",
      email: `cc-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: opts.status ?? "active",
      stripeAccountId: opts.stripeAccountId ?? null,
      connectRedirectOrigins: opts.origins ?? [ORIGIN],
      detailsSubmitted: opts.detailsSubmitted ?? false,
    });
    clientIds.push(id);
    return { id, apiKey };
  }

  const row = async (id: string) => (await db.select().from(clients).where(eq(clients.id, id)))[0];

  const call = (
    method: "GET" | "POST",
    url: string,
    apiKey: string | undefined,
    payload?: unknown
  ) =>
    app.inject({
      method,
      url: `/api/v1/connect/${url}`,
      headers: { ...(apiKey ? { "x-api-key": apiKey } : {}), "content-type": "application/json" },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const link = (apiKey: string | undefined, body: Record<string, unknown> = {}) =>
    call("POST", "onboarding-link", apiKey, {
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
      ...body,
    });

  beforeAll(async () => {
    process.env.FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    app = await buildServer();
  });

  afterAll(async () => {
    for (const id of clientIds) await db.delete(clients).where(eq(clients.id, id));
    if (app) await app.close();
  });

  // Stripe account ids are unique per client row, so each test starts from clean rows.
  afterEach(async () => {
    for (const id of clientIds.splice(0)) await db.delete(clients).where(eq(clients.id, id));
  });

  beforeEach(() => {
    vi.resetAllMocks();
    hitBuckets.clear();
    resetCircuitBreakersForTests();
    vi.mocked(stripe.accountLinks.create).mockResolvedValue({
      url: LINK_URL,
      expires_at: 1_900_000_000,
    } as never);
    vi.mocked(stripe.accounts.del).mockResolvedValue({ deleted: true } as never);
  });

  describe.each([
    ["POST", "onboarding-link"],
    ["GET", "account"],
    ["POST", "dashboard-link"],
  ] as const)("%s /connect/%s auth", (method, path) => {
    it("requires an API key", async () => {
      const res = await call(method, path, undefined, method === "POST" ? {} : undefined);
      expect(res.statusCode).toBe(401);
      expect(stripe.accounts.create).not.toHaveBeenCalled();
    });

    it("rejects an inactive client", async () => {
      const c = await seedClient({ status: "inactive", stripeAccountId: "acct_inactive" });
      const res = await call(method, path, c.apiKey, method === "POST" ? {} : undefined);
      expect(res.statusCode).toBe(401);
      expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    });
  });

  describe("POST /connect/onboarding-link", () => {
    it("creates the account on first use, persists it and returns the link", async () => {
      const c = await seedClient();
      vi.mocked(stripe.accounts.create).mockResolvedValue({ id: "acct_new1" } as never);
      const res = await link(c.apiKey);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        url: LINK_URL,
        expiresAt: new Date(1_900_000_000 * 1000).toISOString(),
      });
      expect((await row(c.id)).stripeAccountId).toBe("acct_new1");
      const [params] = vi.mocked(stripe.accountLinks.create).mock.calls[0];
      expect(params).toMatchObject({
        account: "acct_new1",
        type: "account_onboarding",
        return_url: RETURN_URL,
        refresh_url: REFRESH_URL,
      });
    });

    it("derives the account from the key and ignores account ids in the body", async () => {
      const c = await seedClient({ stripeAccountId: "acct_mine" });
      const res = await link(c.apiKey, {
        stripeAccountId: "acct_other",
        account: "acct_other",
        clientId: randomUUID(),
      });
      expect(res.statusCode).toBe(200);
      expect(stripe.accounts.create).not.toHaveBeenCalled();
      expect(vi.mocked(stripe.accountLinks.create).mock.calls[0][0]).toMatchObject({
        account: "acct_mine",
      });
    });

    it("creates one account for concurrent first calls", async () => {
      const c = await seedClient();
      // Stripe's idempotency key makes both creates return the same account.
      vi.mocked(stripe.accounts.create).mockResolvedValue({ id: "acct_once" } as never);
      const [a, b] = await Promise.all([link(c.apiKey), link(c.apiKey)]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect((await row(c.id)).stripeAccountId).toBe("acct_once");
      for (const [, opts] of vi.mocked(stripe.accounts.create).mock.calls as unknown[][]) {
        expect(opts).toEqual({ idempotencyKey: `acct-create-${c.id}` });
      }
      expect(stripe.accounts.del).not.toHaveBeenCalled();
      for (const [params] of vi.mocked(stripe.accountLinks.create).mock.calls) {
        expect(params).toMatchObject({ account: "acct_once" });
      }
    });

    it("keeps one persisted account and discards a racing loser", async () => {
      const c = await seedClient();
      vi.mocked(stripe.accounts.create)
        .mockResolvedValueOnce({ id: "acct_a" } as never)
        .mockResolvedValueOnce({ id: "acct_b" } as never);
      const [r1, r2] = await Promise.all([link(c.apiKey), link(c.apiKey)]);
      expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
      const persisted = (await row(c.id)).stripeAccountId as string;
      expect(["acct_a", "acct_b"]).toContain(persisted);
      const loser = persisted === "acct_a" ? "acct_b" : "acct_a";
      expect(stripe.accounts.del).toHaveBeenCalledTimes(1);
      expect(stripe.accounts.del).toHaveBeenCalledWith(loser);
      for (const [params] of vi.mocked(stripe.accountLinks.create).mock.calls) {
        expect(params).toMatchObject({ account: persisted });
      }
    });

    it.each([
      ["a foreign origin", { returnUrl: "https://evil.example.com/x" }],
      ["a foreign refresh origin", { refreshUrl: "https://evil.example.com/x" }],
      ["a lookalike host", { returnUrl: "https://app.client-example.com.evil.com/x" }],
      ["credentials in the URL", { returnUrl: "https://app.client-example.com@evil.com/x" }],
      ["a different port", { returnUrl: "https://app.client-example.com:8443/x" }],
      ["plain http", { returnUrl: "http://app.client-example.com/x" }],
      ["a javascript: URL", { returnUrl: "javascript:alert(1)" }],
      ["a relative URL", { refreshUrl: "/settings" }],
    ])("rejects %s", async (_label, override) => {
      const c = await seedClient({ stripeAccountId: "acct_v" });
      const res = await link(c.apiKey, override);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("REDIRECT_URL_NOT_ALLOWED");
      expect(stripe.accountLinks.create).not.toHaveBeenCalled();
    });

    it("rejects a missing url with 400 and creates nothing", async () => {
      const c = await seedClient();
      const res = await call("POST", "onboarding-link", c.apiKey, { returnUrl: RETURN_URL });
      expect(res.statusCode).toBe(400);
      expect(stripe.accounts.create).not.toHaveBeenCalled();
    });

    it("refuses with 409 when no origins are configured, before creating an account", async () => {
      const c = await seedClient({ origins: [] });
      const res = await link(c.apiKey);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("REDIRECT_ORIGINS_NOT_CONFIGURED");
      expect(stripe.accounts.create).not.toHaveBeenCalled();
    });

    it("sends Stripe the canonical parsed href, not the raw string", async () => {
      const c = await seedClient({ stripeAccountId: "acct_canon" });
      const res = await link(c.apiKey, {
        returnUrl: `${ORIGIN}\\@evil.com/back?x=1`,
        refreshUrl: "HTTPS://APP.client-example.com/settings/payments?refresh=1",
      });
      expect(res.statusCode).toBe(200);
      expect(stripe.accountLinks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          return_url: "https://app.client-example.com/@evil.com/back?x=1",
          refresh_url: REFRESH_URL,
        })
      );
    });

    describe("log output", () => {
      let logApp: any;
      const lines: string[] = [];

      beforeAll(async () => {
        logApp = await buildServer({ logStream: { write: (line) => void lines.push(line) } });
      });
      afterAll(async () => {
        if (logApp) await logApp.close();
      });
      beforeEach(() => {
        lines.length = 0;
      });

      const callOnLogApp = (apiKey: string) =>
        logApp.inject({
          method: "POST",
          url: "/api/v1/connect/onboarding-link",
          headers: { "x-api-key": apiKey, "content-type": "application/json" },
          payload: { returnUrl: RETURN_URL, refreshUrl: REFRESH_URL },
        });

      const expectNoSecrets = () => {
        const out = lines.join("\n");
        expect(out).toContain("Client Connect onboarding link"); // the route did log
        for (const secret of [LINK_URL, "SECRETTOKEN", RETURN_URL, REFRESH_URL]) {
          expect(out).not.toContain(secret);
        }
      };

      it("never logs the Stripe link URL or the redirect URLs on success", async () => {
        const c = await seedClient({ stripeAccountId: "acct_log" });
        const res = await callOnLogApp(c.apiKey);
        expect(res.statusCode).toBe(200);
        expectNoSecrets();
      });

      it("never logs the Stripe link URL or the redirect URLs on a Stripe failure", async () => {
        const c = await seedClient({ stripeAccountId: "acct_log_err" });
        vi.mocked(stripe.accountLinks.create).mockRejectedValue(new Error("boom"));
        const res = await callOnLogApp(c.apiKey);
        expect(res.statusCode).toBe(502);
        expectNoSecrets();
      });
    });
  });

  describe("Stripe error mapping", () => {
    const sdkError = (type: string, statusCode: number, message: string) =>
      type === "permission_error"
        ? new Stripe.errors.StripePermissionError({ type, statusCode, message } as never)
        : Stripe.errors.StripeError.generate({ type, statusCode, message } as never);

    // Each route, wired so that the one Stripe call under test rejects with `err`.
    const routes = {
      "POST onboarding-link": async (err: Error) => {
        const c = await seedClient({ stripeAccountId: "acct_err" });
        vi.mocked(stripe.accountLinks.create).mockRejectedValue(err);
        return call("POST", "onboarding-link", c.apiKey, {
          returnUrl: RETURN_URL,
          refreshUrl: REFRESH_URL,
        });
      },
      "GET account": async (err: Error) => {
        const c = await seedClient({ stripeAccountId: "acct_err" });
        vi.mocked(stripe.accounts.retrieve).mockRejectedValue(err);
        return call("GET", "account", c.apiKey);
      },
      "POST dashboard-link": async (err: Error) => {
        const c = await seedClient({ stripeAccountId: "acct_err" });
        vi.mocked(stripe.accounts.retrieve).mockResolvedValue({
          id: "acct_err",
          details_submitted: true,
        } as never);
        vi.mocked(stripe.accounts.createLoginLink).mockRejectedValue(err);
        return call("POST", "dashboard-link", c.apiKey, {});
      },
    };

    describe.each(Object.entries(routes))("%s", (_name, run) => {
      it.each([
        ["invalid request", "invalid_request_error", 400, 400, "INVALID_REQUEST"],
        ["idempotency mismatch", "idempotency_error", 400, 409, "IDEMPOTENCY_KEY_REUSED"],
        ["permission", "permission_error", 403, 409, "ACCOUNT_NOT_CONNECTED"],
      ])("maps a permanent %s error to a non-retryable response", async (_l, type, st, status, code) => {
        const res = await run(sdkError(type, st, "stripe detail"));
        expect(res.statusCode).toBe(status);
        expect(res.json().code).toBe(code);
        expect(res.headers["retry-after"]).toBeUndefined();
      });

      it("keeps a transient Stripe failure retryable, without leaking its message", async () => {
        const res = await run(sdkError("api_error", 500, "internal stripe detail"));
        expect(res.statusCode).toBe(502);
        expect(res.json().code).toBe("STRIPE_FAILED");
        expect(res.body).not.toContain("internal stripe detail");
      });

      it("keeps a Stripe rate limit retryable with Retry-After", async () => {
        const res = await run(sdkError("rate_limit_error", 429, "slow down"));
        expect(res.statusCode).toBe(429);
        expect(res.headers["retry-after"]).toBeDefined();
      });
    });
  });

  describe("GET /connect/account", () => {
    it("reports hasAccount:false without calling Stripe", async () => {
      const c = await seedClient();
      const res = await call("GET", "account", c.apiKey);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        hasAccount: false,
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: { currentlyDue: [], pastDue: [], disabledReason: null },
        capabilities: {},
      });
      expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    });

    it("maps the live account and syncs the client row", async () => {
      const c = await seedClient({ stripeAccountId: "acct_live" });
      vi.mocked(stripe.accounts.retrieve).mockResolvedValue({
        id: "acct_live",
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: false,
        capabilities: { card_payments: "active", transfers: "active" },
        requirements: {
          currently_due: ["external_account"],
          past_due: [],
          disabled_reason: "requirements.pending_verification",
          eventually_due: ["x"],
        },
      } as never);
      const res = await call("GET", "account", c.apiKey);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        hasAccount: true,
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: false,
        requirements: {
          currentlyDue: ["external_account"],
          pastDue: [],
          disabledReason: "requirements.pending_verification",
        },
        capabilities: { card_payments: "active", transfers: "active" },
      });
      expect(stripe.accounts.retrieve).toHaveBeenCalledWith("acct_live");
      const r = await row(c.id);
      expect(r).toMatchObject({
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: false,
        cardPaymentsStatus: "active",
      });
    });

    it("is rate limited per client", async () => {
      const c = await seedClient();
      let last = 200;
      for (let i = 0; i < 61; i++) last = (await call("GET", "account", c.apiKey)).statusCode;
      expect(last).toBe(429);
    });
  });

  describe("POST /connect/dashboard-link", () => {
    it("returns 409 ONBOARDING_INCOMPLETE when there is no account", async () => {
      const c = await seedClient();
      const res = await call("POST", "dashboard-link", c.apiKey, {});
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ONBOARDING_INCOMPLETE");
      expect(stripe.accounts.createLoginLink).not.toHaveBeenCalled();
    });

    it("returns 409 ONBOARDING_INCOMPLETE when details are not submitted", async () => {
      // The stored flag is stale-true; the live account decides.
      const c = await seedClient({ stripeAccountId: "acct_half", detailsSubmitted: true });
      vi.mocked(stripe.accounts.retrieve).mockResolvedValue({
        id: "acct_half",
        details_submitted: false,
      } as never);
      const res = await call("POST", "dashboard-link", c.apiKey, {});
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ONBOARDING_INCOMPLETE");
      expect(stripe.accounts.createLoginLink).not.toHaveBeenCalled();
      expect((await row(c.id)).detailsSubmitted).toBe(false);
    });

    it("creates a login link for the key's own account after onboarding", async () => {
      const c = await seedClient({ stripeAccountId: "acct_done" });
      vi.mocked(stripe.accounts.retrieve).mockResolvedValue({
        id: "acct_done",
        details_submitted: true,
      } as never);
      vi.mocked(stripe.accounts.createLoginLink).mockResolvedValue({
        url: "https://connect.stripe.com/express/abc",
      } as never);
      const res = await call("POST", "dashboard-link", c.apiKey, { stripeAccountId: "acct_other" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ url: "https://connect.stripe.com/express/abc" });
      expect(stripe.accounts.createLoginLink).toHaveBeenCalledWith("acct_done");
    });
  });
});
