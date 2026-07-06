import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn(), retrieve: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
  },
}));

vi.mock("../../lib/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  clearTransporterCache: vi.fn(),
}));

vi.mock("../../lib/rate-limit", () => ({
  adminRateLimit: () => async () => {},
  rateLimit: () => async () => {},
  warnIfInMemoryRateLimit: vi.fn(),
}));

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { apiKeyRegenerationTokens, clients } from "../../db/schema";
import { ensureBaseEnv } from "../helpers/env";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Number of concurrent redemption requests fired at the same pending token.
const CONCURRENT_REQUESTS = 5;

/**
 * Regression coverage for #114 (closes #95): POST /api-key/regenerate used
 * to read the token's status, decide it was "pending", and only afterwards
 * write "completed" — a read-then-write window that let two concurrent
 * requests for the same token both pass validation and both mint a new API
 * key. The fix replaced that with a single conditional UPDATE
 * (`SET status = 'completed' WHERE id = ... AND status = 'pending'`) inside
 * a transaction, so only the request that actually flips the row can
 * proceed to mint a key; every other racer's UPDATE matches zero rows and
 * is rejected as "already been used".
 *
 * This runs against the real Postgres instance (DATABASE_URL below) rather
 * than a mocked DB — an in-memory/mocked store can't reproduce the
 * write-write conflict that made the original bug possible, which is the
 * entire point of this test.
 */
describe("Concurrent redemption of the same regeneration token (TOCTOU)", () => {
  let app: any;
  const cleanupClientIds: string[] = [];

  beforeAll(async () => {
    ensureBaseEnv();
    process.env.API_BASE_URL = "http://localhost:4242";
    app = await buildServer();
  });

  afterAll(async () => {
    for (const id of cleanupClientIds) {
      await db
        .delete(apiKeyRegenerationTokens)
        .where(eq(apiKeyRegenerationTokens.clientId, id))
        .catch(() => undefined);
      await db
        .delete(clients)
        .where(eq(clients.id, id))
        .catch(() => undefined);
    }
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it(`allows exactly one winner across ${CONCURRENT_REQUESTS} concurrent redemption requests for the same token`, async () => {
    const clientId = crypto.randomUUID();
    const email = `race-${clientId}@example.com`;
    const originalApiKeyHash = `hashed:original-${clientId}`;
    const originalApiKeyLookup = `original-lookup-${clientId}`;

    await db.insert(clients).values({
      id: clientId,
      name: "Race Test Client",
      email,
      status: "active",
      apiKeyHash: originalApiKeyHash,
      apiKeyLookup: originalApiKeyLookup,
    });
    cleanupClientIds.push(clientId);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);

    await db.insert(apiKeyRegenerationTokens).values({
      id: crypto.randomUUID(),
      clientId,
      token: tokenHash,
      status: "pending",
      email,
    });

    const requests = Array.from({ length: CONCURRENT_REQUESTS }, () =>
      app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate",
        headers: { "content-type": "application/json" },
        payload: { token: rawToken },
      })
    );

    const responses = await Promise.all(requests);

    const successes = responses.filter((r) => r.statusCode === 200);
    const failures = responses.filter((r) => r.statusCode !== 200);

    // Load-bearing assertion for the #114 fix: if the conditional-update
    // guard in validateAndRegenerate ever regresses to a read-then-write
    // race, more than one concurrent request can observe "pending" before
    // any of them commits the "completed" transition, and more than one
    // would succeed here. Do NOT weaken this to `toBeGreaterThanOrEqual(1)`
    // or similar — an occasional >1 success is a real regression finding,
    // not test flakiness to be tolerated.
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(CONCURRENT_REQUESTS - 1);

    for (const failure of failures) {
      expect(failure.statusCode).toBe(400);
      expect(failure.json().error).toMatch(/already been used/i);
    }

    const winningApiKey = successes[0].json().apiKey;
    expect(typeof winningApiKey).toBe("string");
    expect(winningApiKey.length).toBe(64);

    // The DB shows the token consumed exactly once.
    const tokenRows = await db
      .select()
      .from(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.token, tokenHash));
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0].status).toBe("completed");

    // The client's key hash matches the single winner — not left stale and
    // not clobbered by a second racer finishing after the first.
    const [clientRow] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(clientRow.apiKeyLookup).toBe(hashToken(winningApiKey));
    expect(clientRow.apiKeyLookup).not.toBe(originalApiKeyLookup);
    expect(clientRow.apiKeyHash).not.toBe(originalApiKeyHash);
  });
});
