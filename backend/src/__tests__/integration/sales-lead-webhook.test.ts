import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { salesLeadSubmissions, salesLeadSyncState } from "../../db/schema";
import { SALES_LEAD_WEBHOOK_RATE_LIMIT_MAX } from "../../lib/constants";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { hitBuckets } from "../../lib/rate-limit";
import {
  getSalesLeadSyncStats,
  resetSalesLeadSyncStateForTests,
  runSalesLeadCycle,
  type SalesLeadPoller,
  startSalesLeadPoller,
  triggerSalesLeadSync,
} from "../../lib/sales-lead-sync";
import { ensureBaseEnv } from "../helpers/env";
import { FakeNextcloud, type LeadAnswers, salesLeadEnv } from "../helpers/fake-nextcloud";

const URL = "/api/v1/webhooks/nextcloud/sales-lead";
const SECRET = "sales-lead-secret-0123456789abcdefghij";
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const LEAD: LeadAnswers = { Company: "Zephyrine Widgets LLC", Notes: "Wants a quote" };

describe("POST /webhooks/nextcloud/sales-lead", () => {
  let app: any;
  let fake: FakeNextcloud;
  let poller: SalesLeadPoller | null = null;

  // Records the baseline, then starts the poller (long interval) and waits for its first cycle.
  const start = async (env = salesLeadEnv({ SALES_LEAD_WEBHOOK_SECRET: SECRET })) => {
    await runSalesLeadCycle({ logger: silent, env });
    resetSalesLeadSyncStateForTests();
    poller = startSalesLeadPoller(silent, { ...env, SALES_POLL_INTERVAL_MS: "600000" });
    await vi.waitFor(() => expect(getSalesLeadSyncStats().lastCycleAt).not.toBeNull());
  };
  const post = (headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: URL, headers, payload: { anything: true } });
  const auth = { authorization: `Bearer ${SECRET}` };

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  beforeEach(async () => {
    await db.delete(salesLeadSubmissions);
    await db.delete(salesLeadSyncState);
    hitBuckets.clear();
    resetNextcloudBreakerForTests();
    resetSalesLeadSyncStateForTests();
    fake = new FakeNextcloud();
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
  });
  afterEach(async () => {
    await poller?.stop();
    poller = null;
    resetSalesLeadSyncStateForTests();
    vi.unstubAllGlobals();
  });

  it("is 404 when the poller is not running", async () => {
    expect((await post(auth)).statusCode).toBe(404);
  });

  it("is 404 when no webhook secret is configured (poll only)", async () => {
    await start(salesLeadEnv());
    expect((await post({ authorization: "Bearer anything" })).statusCode).toBe(404);
  });

  it("is 401 for a missing, wrong or near-miss secret, without a cycle", async () => {
    await start();
    const before = vi.mocked(fetch).mock.calls.length;
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { authorization: `Basic ${SECRET}` },
      { authorization: `Bearer ${SECRET.slice(0, -1)}` },
      { authorization: `Bearer ${SECRET} ` },
    ] as Record<string, string>[]) {
      const res = await post(headers);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
    }
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });

  it("rate limits ahead of the secret check", async () => {
    await start();
    for (let i = 0; i < SALES_LEAD_WEBHOOK_RATE_LIMIT_MAX; i++) {
      expect((await post({ authorization: "Bearer wrong" })).statusCode).toBe(401);
    }
    expect((await post(auth)).statusCode).toBe(429);
  });

  it("answers 202 and processes the submission read from Forms, not the payload", async () => {
    await start();
    fake.addSubmission(1, LEAD);
    const res = await post(auth);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    await vi.waitFor(async () => {
      const rows = await db.select().from(salesLeadSubmissions);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("completed");
    });
  });

  it("triggerSalesLeadSync() starts a cycle on the running poller", async () => {
    await start();
    fake.addSubmission(1, LEAD);
    triggerSalesLeadSync();
    await vi.waitFor(async () => {
      const rows = await db.select().from(salesLeadSubmissions);
      expect(rows[0]?.status).toBe("completed");
    });
  });

  it("rejects the secret when it is shorter than 32 characters (poller does not start)", () => {
    expect(
      startSalesLeadPoller(silent, salesLeadEnv({ SALES_LEAD_WEBHOOK_SECRET: "short" }))
    ).toBeNull();
  });

  it("is 404 again after the poller stops", async () => {
    await start();
    await poller?.stop();
    poller = null;
    expect((await post(auth)).statusCode).toBe(404);
  });
});
