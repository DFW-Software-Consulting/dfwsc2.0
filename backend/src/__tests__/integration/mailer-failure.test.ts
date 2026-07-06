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

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { apiKeyRegenerationTokens, clients, onboardingTokens } from "../../db/schema";
import { sendMail } from "../../lib/mailer";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

/**
 * Coverage for how each mail-sending route in connect.ts behaves when
 * `sendMail` rejects.
 *
 * #116 (closes #96) made two routes surface the failure as a 502
 * EMAIL_DELIVERY_FAILED and roll back/revoke the side effect that had
 * already been persisted:
 *   - POST /onboard-client/initiate           -> deletes the client it just created
 *   - POST /api-key/regenerate-request/admin  -> revokes the unsent token
 *     (already covered by the "returns 502 ..." test in
 *     integration/api-key-regeneration.test.ts — not duplicated here; that
 *     test is the template this file mirrors for the routes below.)
 *
 * The other two mail-sending routes were NOT touched by #116 and remain
 * fire-and-forget: they log the error and still report success.
 *   - POST /api-key/regenerate-request (self-service, unauthenticated) looks
 *     intentional — the response is identical whether the account exists,
 *     the email send fails, or both, which avoids leaking account
 *     existence to an unauthenticated caller.
 *   - POST /onboard-client/resend is admin-authenticated (like initiate and
 *     regenerate-request/admin) and already leaks existence via its 404, so
 *     the silent swallow there has no equivalent enumeration justification.
 *     It looks like a gap #116 missed rather than a deliberate design
 *     choice — flagged here, not fixed (out of scope for a test-only PR).
 *
 * This file documents current behavior for all of the above without
 * changing it.
 */
describe("Mailer failure handling across connect.ts routes", () => {
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
        .delete(onboardingTokens)
        .where(eq(onboardingTokens.clientId, id))
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

  describe("POST /api/v1/onboard-client/initiate", () => {
    it("returns 502 EMAIL_DELIVERY_FAILED and rolls back the newly created client when sendMail rejects", async () => {
      const email = `mailer-fail-initiate-${randomUUID()}@example.com`;
      const token = makeAdminToken();
      (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/initiate",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Mailer Fail Client", email, workspace: "client_portal" },
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        error: "Failed to send onboarding email. Please try again.",
        code: "EMAIL_DELIVERY_FAILED",
      });
      expect(sendMail).toHaveBeenCalledTimes(1);

      const [leftoverClient] = await db
        .select()
        .from(clients)
        .where(eq(clients.email, email))
        .limit(1);
      expect(leftoverClient).toBeUndefined();

      // The regeneration token minted just before the failed send must not
      // be left orphaned — it cascades away with the rolled-back client.
      const leftoverTokens = await db
        .select()
        .from(apiKeyRegenerationTokens)
        .where(eq(apiKeyRegenerationTokens.email, email));
      expect(leftoverTokens).toHaveLength(0);
    });
  });

  describe("POST /api/v1/onboard-client/resend", () => {
    it("still returns 200 and leaves the newly-issued token pending when sendMail rejects (fire-and-forget, unlike initiate)", async () => {
      const clientId = randomUUID();
      const email = `mailer-fail-resend-${clientId}@example.com`;
      await db.insert(clients).values({
        id: clientId,
        name: "Mailer Fail Resend Client",
        email,
        status: "active",
      });
      cleanupClientIds.push(clientId);

      const token = makeAdminToken();
      (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/onboard-client/resend",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { clientId },
      });

      // NOTE: unlike initiate and regenerate-request/admin, this admin route
      // does not surface the mail failure at all — see the file-level
      // comment above. This assertion documents that current behavior.
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ clientId });
      expect(sendMail).toHaveBeenCalledTimes(1);

      const tokens = await db
        .select()
        .from(onboardingTokens)
        .where(eq(onboardingTokens.clientId, clientId));
      const pending = tokens.find((t: any) => t.status === "pending");
      expect(pending).toBeDefined();
    });
  });

  describe("POST /api/v1/api-key/regenerate-request", () => {
    it("still returns the generic 200 success message and leaves the token pending when sendMail rejects (fire-and-forget, avoids email enumeration)", async () => {
      const clientId = randomUUID();
      const email = `mailer-fail-selfserve-${clientId}@example.com`;
      await db.insert(clients).values({
        id: clientId,
        name: "Mailer Fail Selfserve Client",
        email,
        status: "active",
      });
      cleanupClientIds.push(clientId);

      (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request",
        headers: { "content-type": "application/json" },
        payload: { email },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().message).toMatch(/regeneration link/i);
      expect(sendMail).toHaveBeenCalledTimes(1);

      // Same generic message as a non-existent email — the caller cannot
      // distinguish "mail delivery failed" from "no such account" here,
      // which is the point of this route swallowing the error.
      const unknownResponse = await app.inject({
        method: "POST",
        url: "/api/v1/api-key/regenerate-request",
        headers: { "content-type": "application/json" },
        payload: { email: `nobody-${randomUUID()}@nowhere.example.com` },
      });
      expect(unknownResponse.statusCode).toBe(200);
      expect(unknownResponse.json().message).toBe(response.json().message);

      const tokens = await db
        .select()
        .from(apiKeyRegenerationTokens)
        .where(eq(apiKeyRegenerationTokens.clientId, clientId));
      const pending = tokens.find((t: any) => t.status === "pending");
      expect(pending).toBeDefined();
    });
  });
});
