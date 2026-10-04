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
  tokenBucketRateLimit: () => async () => {},
  failureRateLimit: () => ({ check: async () => ({ blocked: false }), record: async () => {} }),
  warnIfInMemoryRateLimit: vi.fn(),
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { apiKeyRegenerationTokens, clients } from "../../db/schema";
import { sendMail } from "../../lib/mailer";
import { ensureBaseEnv } from "../helpers/env";

const URL = "/api/v1/api-key/regenerate-request";
const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

describe("POST /api-key/regenerate-request abuse resistance", () => {
  let app: any;
  let clientId: string;
  let email: string;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  const post = (payload: { email: string }) =>
    app.inject({
      method: "POST",
      url: URL,
      headers: { "content-type": "application/json" },
      payload,
    });

  const tokensFor = () =>
    db
      .select()
      .from(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.clientId, clientId));

  const clearTokens = () =>
    db.delete(apiKeyRegenerationTokens).where(eq(apiKeyRegenerationTokens.clientId, clientId));

  beforeAll(async () => {
    ensureBaseEnv();
    process.env.API_BASE_URL = "http://localhost:4242";
    process.on("unhandledRejection", onUnhandled);

    clientId = randomUUID();
    email = `regen-abuse-${clientId}@example.com`;
    await db
      .insert(clients)
      .values({ id: clientId, name: "Regen Abuse Client", email, status: "active" });
    app = await buildServer();
  });

  afterAll(async () => {
    // Let any detached work settle before asserting nothing escaped.
    await settle(50);
    process.off("unhandledRejection", onUnhandled);
    await clearTokens();
    await db.delete(clients).where(eq(clients.id, clientId));
    if (app) await app.close();
    expect(unhandled).toEqual([]);
  });

  beforeEach(async () => {
    await clearTokens();
    vi.clearAllMocks();
  });

  it("answers before the mail is sent: the response does not wait for SMTP", async () => {
    let releaseMail: () => void = () => {};
    (sendMail as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseMail = resolve))
    );

    const response = await post({ email });

    // The response is already in hand while the mail is still pending.
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    releaseMail();
    await settle(20);
  });

  it("returns an identical status and body for a client and an unknown address", async () => {
    const known = await post({ email });
    const unknown = await post({ email: `nobody-${randomUUID()}@nowhere.example.com` });

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json()).toEqual(unknown.json());
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
  });

  it("does not issue a second token or mail while a fresh pending token exists", async () => {
    await post({ email });
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    const [first] = await tokensFor();

    const response = await post({ email });
    expect(response.statusCode).toBe(200);
    // Give the detached work a chance to (wrongly) run.
    await settle();

    const tokens = await tokensFor();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).toBe(first.id);
    expect(tokens[0].status).toBe("pending");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one token and one mail for a burst of simultaneous requests", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => post({ email })));
    for (const response of responses) expect(response.statusCode).toBe(200);

    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    // Give the other detached requests a chance to (wrongly) finish too.
    await settle();

    const tokens = await tokensFor();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe("pending");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("does not revoke a fresh pending token created elsewhere (e.g. the welcome email link)", async () => {
    await db
      .insert(apiKeyRegenerationTokens)
      .values({ id: randomUUID(), clientId, token: "welcome-link-hash", status: "pending", email });

    await post({ email });
    await settle();

    const tokens = await tokensFor();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe("pending");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("issues a new token and revokes the old one once the pending token is older than the cooldown", async () => {
    const oldId = randomUUID();
    await db.insert(apiKeyRegenerationTokens).values({
      id: oldId,
      clientId,
      token: "old-link-hash",
      status: "pending",
      email,
      createdAt: new Date(Date.now() - 6 * 60 * 1000),
    });

    await post({ email });
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));

    const tokens = await tokensFor();
    expect(tokens.find((t: any) => t.id === oldId)?.status).toBe("revoked");
    expect(tokens.filter((t: any) => t.status === "pending")).toHaveLength(1);
  });

  it("issues a new token when the only recent token is no longer pending", async () => {
    await db.insert(apiKeyRegenerationTokens).values({
      id: randomUUID(),
      clientId,
      token: "completed-link-hash",
      status: "completed",
      email,
    });

    await post({ email });
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
  });

  it("logs a detached failure and does not raise an unhandled rejection", async () => {
    const error = new Error("smtp down");
    (sendMail as any).mockRejectedValueOnce(error);
    // request.log is a per-request child of app.log, so capture what the children log.
    const logged: unknown[][] = [];
    const originalChild = app.log.child.bind(app.log);
    const childSpy = vi.spyOn(app.log, "child").mockImplementation((...args: any[]) => {
      const child = originalChild(...args);
      vi.spyOn(child, "error").mockImplementation((...a: any[]) => {
        logged.push(a);
      });
      return child;
    });

    const response = await post({ email });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        logged.some(
          ([obj, msg]) => msg === "Failed to send regeneration email" && (obj as any).err === error
        )
      ).toBe(true)
    );
    await settle(50);

    expect(unhandled).toEqual([]);
    childSpy.mockRestore();
  });

  it("revokes the token when the email fails, so an immediate retry issues a fresh token and email", async () => {
    (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));

    await post({ email });
    await vi.waitFor(async () => {
      const tokens = await tokensFor();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].status).toBe("revoked");
    });
    const [failed] = await tokensFor();

    const retry = await post({ email });
    expect(retry.statusCode).toBe(200);
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(2));

    const tokens = await tokensFor();
    const pending = tokens.filter((t: any) => t.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(failed.id);
  });
});
