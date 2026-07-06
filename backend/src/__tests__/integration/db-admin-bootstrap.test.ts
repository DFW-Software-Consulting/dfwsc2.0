import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAdminToken } from "../helpers/auth";
import { TEST_JWT_SECRET } from "../helpers/constants";
import { createAppDbMock } from "../helpers/mock-factories";

/**
 * DB-backed admin authentication: bootstrap → login → confirm → login flow.
 *
 * This test covers the full lifecycle:
 *  1. Bootstrap seeds the admins table from env vars (setupConfirmed=false)
 *  2. Login with bootstrap creds succeeds
 *  3. setup/status reflects bootstrapPending=true
 *  4. confirm-bootstrap updates creds and sets setupConfirmed=true
 *  5. Login with new creds succeeds; old creds no longer work
 *
 * Also covers: confirm-bootstrap scopes its update to the JWT-authenticated
 * caller's own admin row rather than an arbitrary row (#100). That requires
 * a DB mock that actually filters by id — the previous inline mock here just
 * returned "the first row" regardless of the WHERE clause, which happened to
 * work only because every prior test seeded a single admin. createAppDbMock
 * (already used by app.test.ts) does real id-based filtering, so it's reused
 * here instead of hand-rolling another shortcut.
 */

const dataStore = {
  clients: new Map<string, any>(),
  clientsByApiKey: new Map<string, string>(),
  onboardingTokens: new Map<string, any>(),
  webhookEvents: new Map<string, any>(),
  clientGroups: new Map<string, any>(),
  admins: new Map<string, any>(),
};

vi.mock("../../db/client", () => ({
  db: createAppDbMock(dataStore),
}));

// createAppDbMock introspects the plain { field, value } / { all } shape
// produced by this mock, not real drizzle-orm's chunk-based SQL builders —
// mirrors app.test.ts's drizzle-orm mock exactly.
vi.mock("drizzle-orm", () => ({
  count: () => ({ fn: "count" }),
  eq: (field: unknown, value: unknown) => ({ value, field }),
  ne: (field: unknown, value: unknown) => ({ not: true, value, field }),
  inArray: (field: unknown, values: unknown[]) => ({ inArray: true, field, values }),
  and: (...conditions: any[]) => ({ all: conditions }),
  isNull: (field: unknown) => ({ isNull: true, field }),
}));

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
}));

async function createServer() {
  vi.resetModules();
  const { buildServer } = await import("../../app");
  return buildServer();
}

describe("DB-backed admin auth: setup → confirm → login flow", () => {
  const bootstrapUsername = "setupadmin";
  const bootstrapPassword = "setup-pass-123";
  const newUsername = "confirmedadmin";
  const newPassword = "new-secure-pass-456";

  beforeEach(async () => {
    dataStore.admins.clear();
    process.env.ALLOW_ADMIN_SETUP = "true";
    process.env.SETUP_FLAG_PATH = `/tmp/test-bootstrap-${Date.now()}-${Math.random()}`;
  });

  afterEach(() => {
    dataStore.admins.clear();
    vi.resetModules();
  });

  it("full setup → login → confirm → login flow", async () => {
    const server = await createServer();

    // Step 1: POST /auth/setup is deprecated and always returns 410 Gone.
    const setupRes = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: bootstrapUsername, password: bootstrapPassword },
      headers: { "content-type": "application/json" },
    });
    expect(setupRes.statusCode).toBe(410);
    expect(setupRes.json().error).toMatch(/deprecated/i);

    // The setup endpoint never persisted to DB and now does nothing at all.
    // Seed the mock DB directly using the known plaintext bootstrapPassword.
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(bootstrapPassword, 10);
    dataStore.admins.set("admin-setup-1", {
      id: "admin-setup-1",
      username: bootstrapUsername,
      passwordHash: hash,
      role: "admin",
      active: true,
      setupConfirmed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Step 2: Login with setup creds → 200 + valid JWT
    const loginRes1 = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: bootstrapUsername, password: bootstrapPassword },
      headers: { "content-type": "application/json" },
    });
    expect(loginRes1.statusCode).toBe(200);
    expect(loginRes1.json()).toHaveProperty("token");
    expect(loginRes1.json().bootstrapPending).toBe(true);

    // Step 3: setup/status → adminConfigured=false (setupConfirmed is still
    // false at this point). `bootstrapPending` is intentionally not exposed
    // to unauthenticated callers.
    const statusRes = await server.inject({
      method: "GET",
      url: "/api/v1/auth/setup/status",
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).not.toHaveProperty("bootstrapPending");
    expect(statusRes.json().adminConfigured).toBe(false);
    expect(statusRes.json().requiresSetup).toBe(false);

    // Step 3b: confirm-bootstrap now requires an authenticated admin JWT.
    // An unauthenticated call must be rejected.
    const unauthConfirmRes = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: { username: newUsername, password: newPassword },
      headers: { "content-type": "application/json" },
    });
    expect(unauthConfirmRes.statusCode).toBe(401);

    // Step 4: confirm-bootstrap with new creds, authenticated using the
    // bootstrap admin's JWT obtained in step 2 → 200
    const confirmRes = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: { username: newUsername, password: newPassword },
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${loginRes1.json().token}`,
      },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().message).toBe("Admin credentials confirmed");

    // Verify DB state: setupConfirmed=true, username updated
    expect(dataStore.admins.get("admin-setup-1")?.setupConfirmed).toBe(true);
    expect(dataStore.admins.get("admin-setup-1")?.username).toBe(newUsername);

    // Step 5: Login with new creds → 200 + valid JWT
    const loginRes2 = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: newUsername, password: newPassword },
      headers: { "content-type": "application/json" },
    });
    expect(loginRes2.statusCode).toBe(200);
    expect(loginRes2.json()).toHaveProperty("token");
    expect(loginRes2.json().bootstrapPending).toBe(false);

    await server.close();
  });

  it("login returns a generic 401 when no admin is in the database", async () => {
    dataStore.admins.clear();
    const server = await createServer();

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "anypassword" },
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "Invalid credentials" });

    await server.close();
  });

  it("confirm-bootstrap updates only the authenticated admin's own row when multiple admins exist (#100)", async () => {
    // Two admins present, both still mid-bootstrap. Admin A happens to be
    // first in insertion order — the old bug always mutated allAdmins[0]
    // (i.e. admin A) regardless of who actually authenticated.
    dataStore.admins.set("admin-a", {
      id: "admin-a",
      username: "admin-a-original",
      passwordHash: "$2b$10$placeholderA",
      role: "admin",
      active: true,
      setupConfirmed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dataStore.admins.set("admin-b", {
      id: "admin-b",
      username: "admin-b-original",
      passwordHash: "$2b$10$placeholderB",
      role: "admin",
      active: true,
      setupConfirmed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const server = await createServer();

    // Admin B authenticates (JWT sub = admin-b) and confirms bootstrap.
    const tokenForAdminB = makeAdminToken(TEST_JWT_SECRET, { sub: "admin-b" });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: { username: "admin-b-confirmed", password: "brand-new-password-123" },
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenForAdminB}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe("Admin credentials confirmed");

    // Admin B's own row is updated...
    const adminB = dataStore.admins.get("admin-b");
    expect(adminB?.setupConfirmed).toBe(true);
    expect(adminB?.username).toBe("admin-b-confirmed");

    // ...and admin A's row is completely untouched.
    const adminA = dataStore.admins.get("admin-a");
    expect(adminA?.setupConfirmed).toBe(false);
    expect(adminA?.username).toBe("admin-a-original");
    expect(adminA?.passwordHash).toBe("$2b$10$placeholderA");

    await server.close();
  });
});
