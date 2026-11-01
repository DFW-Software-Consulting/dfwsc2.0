import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeInvoicing } = await import("../helpers/fake-stripe-invoicing");
  return { stripe: fakeInvoicing.stripe };
});

import { buildServer } from "../../app";
import { db } from "../../db/client";
import {
  billingCustomers,
  billingRequestSubmissions,
  billingRequestSyncState,
  portalMirrorRows,
  portalMirrorState,
} from "../../db/schema";
import {
  type BillingRequestsRunner,
  getBillingRequestsStats,
  resetBillingRequestsStateForTests,
  runBillingRequestsCycle,
  startBillingRequests,
} from "../../lib/billing-request-sync";
import { resetCircuitBreakersForTests } from "../../lib/circuit-breakers";
import { BILLING_REQUESTS_WEBHOOK_RATE_LIMIT_MAX } from "../../lib/constants";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { hitBuckets } from "../../lib/rate-limit";
import { isAuthorizedWebhook } from "../../routes/nextcloud-webhooks";
import { ensureBaseEnv } from "../helpers/env";
import {
  BR_FORM_ID,
  BR_WEBHOOK_SECRET,
  billingRequestEnv,
  FakeBillingRequestNextcloud,
} from "../helpers/fake-nextcloud-billing-requests";
import { fakeInvoicing as stripe } from "../helpers/fake-stripe-invoicing";

const URL = "/api/v1/webhooks/nextcloud/billing-request";
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const ANSWERS = {
  client_code: "CP-004",
  company: "Emmut Properties Corp",
  kind: "One-off invoice",
  description: "October retainer",
  amount_usd: "100.00",
};

// What webhook_listeners posts for OCA\Forms\Events\FormSubmittedEvent; never read.
const payload = {
  user: { uid: "alice" },
  event: {
    class: "OCA\\Forms\\Events\\FormSubmittedEvent",
    form: { id: BR_FORM_ID },
    submission: { id: 5, answers: [{ questionId: 305, text: "9999999.00" }] },
  },
};

describe("POST /webhooks/nextcloud/billing-request", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let fake: FakeBillingRequestNextcloud;
  let runner: BillingRequestsRunner | null = null;
  const env = billingRequestEnv({ BILLING_REQUESTS_POLL_INTERVAL_MS: "600000" });

  // Records the baseline, then starts the runner and waits for its start-up cycle.
  const start = async (e = env) => {
    await runBillingRequestsCycle({ logger: silent, env: e, minGapMs: 0 });
    resetBillingRequestsStateForTests();
    runner = startBillingRequests(silent, e);
    await vi.waitFor(() => expect(getBillingRequestsStats().lastCycleAt).not.toBeNull());
  };
  const post = (headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: URL, headers, payload });
  const auth = { authorization: `Bearer ${BR_WEBHOOK_SECRET}` };
  const submission = async (id: number) => {
    const [row] = await db
      .select()
      .from(billingRequestSubmissions)
      .where(eq(billingRequestSubmissions.submissionId, id));
    return row;
  };

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.delete(billingRequestSubmissions);
    await db.delete(billingRequestSyncState);
    await db.delete(billingCustomers);
    await db.delete(portalMirrorRows);
    await db.delete(portalMirrorState);
    await db.insert(billingCustomers).values({
      clientCode: "CP-004",
      company: "Emmut Properties Corp.",
      email: "ap@emmut.example",
      stripeCustomerId: "cus_emmut",
      source: "created",
    });
    stripe.reset();
    hitBuckets.clear();
    resetNextcloudBreakerForTests();
    resetCircuitBreakersForTests();
    resetBillingRequestsStateForTests();
    fake = new FakeBillingRequestNextcloud();
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
  });

  afterEach(async () => {
    await runner?.stop();
    runner = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetNextcloudBreakerForTests();
    resetBillingRequestsStateForTests();
  });

  it("compares the secret exactly", () => {
    expect(isAuthorizedWebhook(`Bearer ${BR_WEBHOOK_SECRET}`, BR_WEBHOOK_SECRET)).toBe(true);
    expect(isAuthorizedWebhook(`Bearer ${BR_WEBHOOK_SECRET}x`, BR_WEBHOOK_SECRET)).toBe(false);
  });

  it("is 404 when billing requests are not running", async () => {
    expect((await post(auth)).statusCode).toBe(404);
  });

  it("is 404 when no webhook secret is configured (poll only)", async () => {
    await start(billingRequestEnv({ BILLING_REQUESTS_WEBHOOK_SECRET: undefined }));
    expect((await post({ authorization: "Bearer anything" })).statusCode).toBe(404);
  });

  it("does not answer for the onboarding secret", async () => {
    await start();
    const res = await post({ authorization: "Bearer client-onboarding-secret-0123456789abcdef" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing, wrong or near-miss secret without starting a cycle or touching Stripe", async () => {
    await start();
    const before = vi.mocked(fetch).mock.calls.length;
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { authorization: `Basic ${BR_WEBHOOK_SECRET}` },
      { authorization: `Bearer ${BR_WEBHOOK_SECRET.slice(0, -1)}` },
      { authorization: `Bearer ${BR_WEBHOOK_SECRET} ` },
    ] as Record<string, string>[]) {
      const res = await post(headers);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
    }
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
    expect(stripe.calls).toHaveLength(0);
  });

  it("refuses a bad secret before the body is read", async () => {
    await start();
    const read = async (headers: Record<string, string>) => {
      const resume = vi.spyOn(Readable.prototype, "resume");
      try {
        const res = await post(headers);
        const bodyRead = resume.mock.contexts.some((c) => (c as { url?: string }).url === URL);
        return { res, bodyRead };
      } finally {
        resume.mockRestore();
      }
    };
    const bad = await read({ authorization: "Bearer wrong" });
    expect(bad.res.statusCode).toBe(401);
    expect(bad.bodyRead).toBe(false);
    const ok = await read(auth);
    expect(ok.res.statusCode).toBe(202);
    expect(ok.bodyRead).toBe(true);
  });

  it("accepts the right secret with no content type and processes the new submission", async () => {
    await start();
    fake.addSubmission(5, ANSWERS);
    const res = await app.inject({ method: "POST", url: URL, headers: auth, payload: "{}" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    await vi.waitFor(async () => expect((await submission(5))?.status).toBe("completed"));
    // The injected answers in the webhook body play no part: the amount comes from the form.
    expect(stripe.callsTo("invoiceItems.create")[0].params?.amount).toBe(10000);
  });

  it("answers 202 for the JSON body Nextcloud sends, which is not used", async () => {
    await start();
    expect((await post(auth)).statusCode).toBe(202);
    await vi.waitFor(() => expect(getBillingRequestsStats().lastCycleStatus).toBe("ok"));
    expect(stripe.calls).toHaveLength(0);
  });

  it("rate limits ahead of the secret check", async () => {
    await start();
    for (let i = 0; i < BILLING_REQUESTS_WEBHOOK_RATE_LIMIT_MAX; i++) {
      expect((await post({ authorization: "Bearer wrong" })).statusCode).toBe(401);
    }
    expect((await post({ authorization: "Bearer wrong" })).statusCode).toBe(429);
    expect((await post(auth)).statusCode).toBe(429);
  });

  it("is independent of the client onboarding webhook", async () => {
    await start();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/nextcloud/client-onboarding",
      headers: auth,
      payload,
    });
    expect(res.statusCode).toBe(404); // onboarding is not running here
  });

  it("is picked up by the poll as well when the webhook is lost", async () => {
    await start();
    fake.addSubmission(6, ANSWERS);
    await runBillingRequestsCycle({ logger: silent, env, minGapMs: 0 });
    expect((await submission(6)).status).toBe("completed");
  });
});
