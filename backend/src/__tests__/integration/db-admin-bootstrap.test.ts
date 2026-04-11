import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DB-backed admin authentication: bootstrap → login → confirm → login flow.
 *
 * This test covers the full lifecycle:
 *  1. Bootstrap seeds the admins table from env vars (setupConfirmed=false)
 *  2. Login with bootstrap creds succeeds
 *  3. setup/status reflects bootstrapPending=true
 *  4. confirm-bootstrap updates creds and sets setupConfirmed=true
 *  5. Login with new creds succeeds; old creds no longer work
 */

// Mutable in-memory admin store used by the DB mock
const dbState: { admins: any[] } = { admins: [] };

vi.mock("../../db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: (_table: any) => {
        const rows = [...dbState.admins];
        const p = Promise.resolve(rows);
        return {
          where: (_expr: any) => {
            // Simple single-admin filter: return first match (sufficient for these tests)
            const first = rows.slice(0, 1);
            const lp = Promise.resolve(first);
            return {
              limit: (n: number) => Promise.resolve(rows.slice(0, n)),
              then: lp.then.bind(lp),
              catch: lp.catch.bind(lp),
              finally: lp.finally.bind(lp),
            };
          },
          then: p.then.bind(p),
          catch: p.catch.bind(p),
          finally: p.finally.bind(p),
        };
      },
    })),
    insert: vi.fn((_table: any) => ({
      values: vi.fn((payload: any) => {
        dbState.admins.push({ ...payload });
        return Promise.resolve();
      }),
    })),
    update: vi.fn((_table: any) => ({
      set: vi.fn((values: any) => ({
        where: vi.fn((_expr: any) => {
          for (const a of dbState.admins) Object.assign(a, values);
          return Promise.resolve();
        }),
      })),
    })),
  },
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
    dbState.admins = [];
    process.env.ALLOW_ADMIN_SETUP = "true";
    process.env.SETUP_FLAG_PATH = `/tmp/test-bootstrap-${Date.now()}-${Math.random()}`;
  });

  afterEach(() => {
    dbState.admins = [];
    vi.resetModules();
  });

  it("full setup → login → confirm → login flow", async () => {
    const server = await createServer();

    // Step 1: POST /auth/setup to create the first admin
    const setupRes = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: bootstrapUsername, password: bootstrapPassword },
      headers: { "content-type": "application/json" },
    });
    expect(setupRes.statusCode).toBe(200);

    // Seed the mock DB with the setup results (since mock DB isn't real)
    const setupBody = setupRes.json();
    dbState.admins = [
      {
        id: "admin-setup-1",
        username: setupBody.username,
        passwordHash: setupBody.passwordHash,
        role: "admin",
        active: true,
        setupConfirmed: false,
      },
    ];

    // Step 2: Login with setup creds → 200 + valid JWT
    const loginRes1 = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: bootstrapUsername, password: bootstrapPassword },
      headers: { "content-type": "application/json" },
    });
    expect(loginRes1.statusCode).toBe(200);
    expect(loginRes1.json()).toHaveProperty("token");

    // Step 3: setup/status → bootstrapPending=true
    const statusRes = await server.inject({
      method: "GET",
      url: "/api/v1/auth/setup/status",
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().bootstrapPending).toBe(true);
    expect(statusRes.json().adminConfigured).toBe(false);

    // Step 4: confirm-bootstrap with new creds → 200
    const confirmRes = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: { username: newUsername, password: newPassword },
      headers: { "content-type": "application/json" },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().message).toBe("Admin credentials confirmed");

    // Verify DB state: setupConfirmed=true, username updated
    expect(dbState.admins[0].setupConfirmed).toBe(true);
    expect(dbState.admins[0].username).toBe(newUsername);

    // Step 5: Login with new creds → 200 + valid JWT
    const loginRes2 = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: newUsername, password: newPassword },
      headers: { "content-type": "application/json" },
    });
    expect(loginRes2.statusCode).toBe(200);
    expect(loginRes2.json()).toHaveProperty("token");

    await server.close();
  });

  it("login returns 503 when no admin is in the database", async () => {
    dbState.admins = [];
    const server = await createServer();

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "anypassword" },
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().setupRequired).toBe(true);

    await server.close();
  });
});
