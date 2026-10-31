import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientOnboardingSubmissions, clientOnboardingSyncState } from "../../db/schema";
import {
  type ClientOnboardingRunner,
  getClientOnboardingStats,
  resetClientOnboardingStateForTests,
  runClientOnboardingCycle,
  startClientOnboarding,
} from "../../lib/client-onboarding-sync";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { isAuthorizedWebhook } from "../../routes/nextcloud-webhooks";
import { ensureBaseEnv } from "../helpers/env";
import {
  FakeOnboardingNextcloud,
  ONB_WEBHOOK_SECRET,
  onboardingEnv,
  PROJECT_COLUMNS,
} from "../helpers/fake-nextcloud-onboarding";

const URL = "/api/v1/webhooks/nextcloud/client-onboarding";
const silent = { info: () => {}, warn: () => {}, error: () => {} };

// What webhook_listeners posts for OCA\Forms\Events\FormSubmittedEvent. The answers
// in it are never used: the route only starts a cycle.
const payload = {
  user: { uid: "messyginger0804", displayName: "JeremyAshley" },
  time: 1793451646,
  event: {
    class: "OCA\\Forms\\Events\\FormSubmittedEvent",
    form: { id: 2, hash: "9KaxpC5GXeGoWY44" },
    submission: {
      id: 5,
      answers: [{ questionId: 205, text: "Injected Project" }],
    },
  },
};

describe("isAuthorizedWebhook", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isAuthorizedWebhook(`Bearer ${ONB_WEBHOOK_SECRET}`, ONB_WEBHOOK_SECRET)).toBe(true);
    expect(isAuthorizedWebhook(undefined, ONB_WEBHOOK_SECRET)).toBe(false);
    expect(isAuthorizedWebhook("", ONB_WEBHOOK_SECRET)).toBe(false);
    expect(isAuthorizedWebhook("Bearer ", ONB_WEBHOOK_SECRET)).toBe(false);
    expect(isAuthorizedWebhook(ONB_WEBHOOK_SECRET, ONB_WEBHOOK_SECRET)).toBe(false);
    expect(isAuthorizedWebhook(`Basic ${ONB_WEBHOOK_SECRET}`, ONB_WEBHOOK_SECRET)).toBe(false);
    expect(isAuthorizedWebhook(`Bearer ${ONB_WEBHOOK_SECRET}x`, ONB_WEBHOOK_SECRET)).toBe(false);
    expect(
      isAuthorizedWebhook(`Bearer ${ONB_WEBHOOK_SECRET.slice(0, -1)}Z`, ONB_WEBHOOK_SECRET)
    ).toBe(false);
  });
});

describe("POST /webhooks/nextcloud/client-onboarding", () => {
  let app: any;
  let fake: FakeOnboardingNextcloud;
  let runner: ClientOnboardingRunner | null = null;

  // Records the baseline, then starts the runner and waits for its start-up cycle.
  const start = async (env = onboardingEnv({ CLIENT_ONBOARDING_POLL_INTERVAL_MS: "600000" })) => {
    await runClientOnboardingCycle({ logger: silent, env });
    resetClientOnboardingStateForTests();
    runner = startClientOnboarding(silent, env);
    await vi.waitFor(() => expect(getClientOnboardingStats().lastCycleAt).not.toBeNull());
  };

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await db.delete(clientOnboardingSubmissions);
    await db.delete(clientOnboardingSyncState);
    resetNextcloudBreakerForTests();
    resetClientOnboardingStateForTests();
    fake = new FakeOnboardingNextcloud();
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
  });

  afterEach(async () => {
    await runner?.stop();
    runner = null;
    resetClientOnboardingStateForTests();
    vi.unstubAllGlobals();
  });

  const post = (headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: URL, headers, payload });

  it("is 404 when the onboarding is not running", async () => {
    const res = await post({ authorization: `Bearer ${ONB_WEBHOOK_SECRET}` });
    expect(res.statusCode).toBe(404);
  });

  it("is 404 when no webhook secret is configured (poll only)", async () => {
    await start(onboardingEnv({ CLIENT_ONBOARDING_WEBHOOK_SECRET: undefined }));
    const res = await post({ authorization: "Bearer anything" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a missing secret without starting a cycle", async () => {
    await start();
    const before = vi.mocked(fetch).mock.calls.length;
    const res = await post();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });

  it("rejects a wrong secret, a wrong scheme and a near miss", async () => {
    await start();
    const before = vi.mocked(fetch).mock.calls.length;
    for (const authorization of [
      "Bearer wrong",
      `Basic ${ONB_WEBHOOK_SECRET}`,
      `Bearer ${ONB_WEBHOOK_SECRET.slice(0, -1)}`,
      `Bearer ${ONB_WEBHOOK_SECRET} `,
    ]) {
      expect((await post({ authorization })).statusCode).toBe(401);
    }
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });

  it("accepts the body as webhook_listeners sends it: no Content-Type header", async () => {
    await start();
    const unauthorized = await app.inject({
      method: "POST",
      url: URL,
      payload: JSON.stringify(payload),
    });
    expect(unauthorized.statusCode).toBe(401);
    for (const headers of [
      {},
      { "content-type": "text/plain" },
      { "content-type": "application/json" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: { ...headers, authorization: `Bearer ${ONB_WEBHOOK_SECRET}` },
        payload: "{ not json",
      });
      expect(res.statusCode).toBe(202);
    }
  });

  it("still parses JSON on other routes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("answers 202 at once and processes the submission from the Forms API, not the payload", async () => {
    await start();
    fake.addSubmission(5, {
      company: "Zephyrine Widgets LLC",
      project_name: "Warehouse Portal",
      summary: "Build the portal",
    });
    const res = await post({ authorization: `Bearer ${ONB_WEBHOOK_SECRET}` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });

    const created = () => fake.projectRows().filter((r) => r.id >= 1000);
    await vi.waitFor(() => expect(created()).toHaveLength(1));
    await vi.waitFor(() => expect(fake.count("PUT", "/rows/")).toBeGreaterThan(0));
    await runner?.stop();
    expect(created()).toHaveLength(1);
    expect(created()[0].data.get(PROJECT_COLUMNS["Project Name"])).toBe("Warehouse Portal");
    expect(JSON.stringify([...created()[0].data.values()])).not.toContain("Injected");
  });
});
