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
}));

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { apiKeyRegenerationTokens, clients } from "../../db/schema";
import { sendMail } from "../../lib/mailer";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

const REGEN_LINK_REGEX = /\/regenerate-key\?token=([a-f0-9]+)/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Onboard Initiate — API key via email link", () => {
  let app: any;
  const createdClientIds: string[] = [];

  beforeAll(async () => {
    ensureBaseEnv();
    process.env.API_BASE_URL = "http://localhost:4242";
    app = await buildServer();
  });

  afterAll(async () => {
    for (const id of createdClientIds) {
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

  it("returns 201 with null apiKey and emails both onboarding + retrieval links", async () => {
    const email = `onboard-init-${randomUUID()}@example.com`;
    const token = makeAdminToken();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { name: "Initiate Client", email, workspace: "client_portal" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ message: "Onboarding email sent successfully." });
    expect(body.apiKey).toBeNull();
    expect(body.clientId).toBeDefined();
    createdClientIds.push(body.clientId);

    const mailCall = (sendMail as any).mock.calls.at(-1)?.[0];
    expect(mailCall).toBeTruthy();
    expect(mailCall.to).toBe(email);
    expect(mailCall.html).toContain("/onboard?token=");
    expect(mailCall.html).toMatch(REGEN_LINK_REGEX);
    expect(mailCall.text).toContain("/onboard?token=");
    expect(mailCall.text).toMatch(REGEN_LINK_REGEX);
    expect(mailCall.html).toMatch(/15 minutes/i);

    const tokens = await db
      .select()
      .from(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.clientId, body.clientId));
    const pending = tokens.find((t: any) => t.status === "pending");
    expect(pending).toBeDefined();
    expect(pending.email).toBe(email);

    const rawToken = mailCall.text.match(REGEN_LINK_REGEX)[1];
    expect(pending.token).toBe(sha256(rawToken));
  });

  it("does not return the plaintext apiKey in the response body", async () => {
    const email = `onboard-nokey-${randomUUID()}@example.com`;
    const token = makeAdminToken();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { name: "No Key Client", email, workspace: "client_portal" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.apiKey).toBeNull();
    expect(body.clientId).toBeDefined();
    createdClientIds.push(body.clientId);
    expect(JSON.stringify(body)).not.toMatch(/apiKey"\s*:\s*"[a-f0-9]+"/);
  });

  it("the retrieval link returns a new API key when consumed", async () => {
    const email = `onboard-retrieve-${randomUUID()}@example.com`;
    const token = makeAdminToken();

    const initiate = await app.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { name: "Retrieve Client", email, workspace: "client_portal" },
    });

    expect(initiate.statusCode).toBe(201);
    const clientId = initiate.json().clientId;
    createdClientIds.push(clientId);

    const mailCall = (sendMail as any).mock.calls.at(-1)?.[0];
    const rawToken = mailCall.text.match(REGEN_LINK_REGEX)[1];

    const regenerate = await app.inject({
      method: "POST",
      url: "/api/v1/api-key/regenerate",
      headers: { "content-type": "application/json" },
      payload: { token: rawToken },
    });

    expect(regenerate.statusCode).toBe(200);
    const newApiKey = regenerate.json().apiKey;
    expect(typeof newApiKey).toBe("string");
    expect(newApiKey).toMatch(/^[a-f0-9]{64}$/);

    const [clientRow] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(clientRow.apiKeyLookup).toBe(sha256(newApiKey));

    const [tokenRow] = await db
      .select()
      .from(apiKeyRegenerationTokens)
      .where(eq(apiKeyRegenerationTokens.token, sha256(rawToken)))
      .limit(1);
    expect(tokenRow.status).toBe("completed");
  });

  it("returns 401 without an admin JWT", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: { "content-type": "application/json" },
      payload: { name: "Auth Client", email: `onboard-auth-${randomUUID()}@example.com` },
    });

    expect(response.statusCode).toBe(401);
  });
});
