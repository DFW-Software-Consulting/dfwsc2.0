import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Stripe to avoid real API calls
vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
}));

// Mutable in-memory admin store for DB mock
const dbState: { admins: any[] } = { admins: [] };

vi.mock("../../db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: (_table: any) => {
        const rows = [...dbState.admins];
        const p = Promise.resolve(rows);
        return {
          where: (_expr: any) => {
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

// Ensure all env vars required by validateEnv are set for every test in this file
function ensureBaseEnv() {
  process.env.FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
  process.env.USE_CHECKOUT = process.env.USE_CHECKOUT ?? "false";
  process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
  process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
  process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
  process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
}

// Helper: build a fresh server with a clean module state
async function createServer() {
  ensureBaseEnv();
  // Use a unique flag path so existsSync() always returns false for a fresh server
  process.env.SETUP_FLAG_PATH = `/tmp/test-setup-${Date.now()}-${Math.random()}`;
  vi.resetModules();
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  const { buildServer } = await import("../../app");
  const server = await buildServer();
  // validateEnv() inside buildServer() calls dotenv.config() which reloads .env
  // and may restore ADMIN_USERNAME/ADMIN_PASSWORD — delete them again so tests
  // that want no admin configured see a clean environment at request time.
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  return server;
}

describe("POST /api/v1/auth/setup", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    dbState.admins = [];
    // Reset setup state before every test
    vi.resetModules();
    const authRoutes = await import("../../routes/auth");
    authRoutes.resetSetupState();
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.resetModules();
    dbState.admins = [];
  });

  it("returns 403 when ALLOW_ADMIN_SETUP is not set", async () => {
    delete process.env.ALLOW_ADMIN_SETUP;
    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "securepass123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("Admin setup is not enabled");

    await server.close();
  });

  it("returns 403 when admin is already configured (ADMIN_PASSWORD already set)", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    const server = await createServer();
    // createServer() scrubs ADMIN_PASSWORD after dotenv reloads; re-set it here
    // to simulate a server that already has admin credentials configured in ENV.
    process.env.ADMIN_PASSWORD = "testpassword";

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "securepass123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("Admin is already configured");

    await server.close();
    delete process.env.ALLOW_ADMIN_SETUP;
  });

  it("returns 403 when admin is already configured (Admin exists in DB)", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    // Seed DB with an admin
    dbState.admins = [
      {
        id: "admin-1",
        username: "admin",
        passwordHash: "hash",
        role: "admin",
        active: true,
        setupConfirmed: true,
      },
    ];

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "securepass123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("Admin is already configured");

    await server.close();
    delete process.env.ALLOW_ADMIN_SETUP;
  });

  it('returns 403 "Setup has already been used" when setupUsed flag is set', async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    // Clear admin credentials to allow setup
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;

    const server = await createServer();

    // First call succeeds (sets setupUsed=true)
    const firstResponse = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "securepass123" },
      headers: { "content-type": "application/json" },
    });

    expect(firstResponse.statusCode).toBe(200);

    // Second call should see setupUsed=true → 403
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "securepass123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("Setup has already been used this session");

    await server.close();
    process.env.ADMIN_USERNAME = savedEnv.ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = savedEnv.ADMIN_PASSWORD;
    delete process.env.ALLOW_ADMIN_SETUP;
  });

  it("returns 401 when ADMIN_SETUP_TOKEN is set but wrong token is provided", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    process.env.ADMIN_SETUP_TOKEN = "correct-secret-token";
    // Clear admin credentials to allow setup
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "securepass123" },
      headers: {
        "content-type": "application/json",
        "x-setup-token": "wrong-token",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("Invalid setup token");

    await server.close();
    process.env.ADMIN_USERNAME = savedEnv.ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = savedEnv.ADMIN_PASSWORD;
    delete process.env.ALLOW_ADMIN_SETUP;
    delete process.env.ADMIN_SETUP_TOKEN;
  });

  it("returns 400 when username is missing from body", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    // Clear admin credentials to allow setup
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { password: "securepass123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/username|password/i);

    await server.close();
    process.env.ADMIN_USERNAME = savedEnv.ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = savedEnv.ADMIN_PASSWORD;
    delete process.env.ALLOW_ADMIN_SETUP;
  });

  it("returns 400 when password is shorter than 8 characters", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    // Clear admin credentials to allow setup
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "short" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/8 characters/i);

    await server.close();
    process.env.ADMIN_USERNAME = savedEnv.ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = savedEnv.ADMIN_PASSWORD;
    delete process.env.ALLOW_ADMIN_SETUP;
  });

  it("returns 200 with username, passwordHash, and instructions on success", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    // Clear admin credentials to allow setup
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "newadmin", password: "securepass123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.username).toBe("newadmin");
    expect(body.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(Array.isArray(body.instructions)).toBe(true);
    expect(body.instructions.length).toBeGreaterThan(4);

    await server.close();
    process.env.ADMIN_USERNAME = savedEnv.ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = savedEnv.ADMIN_PASSWORD;
    delete process.env.ALLOW_ADMIN_SETUP;
  });
});

describe("POST /api/v1/auth/login — uncovered branches", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    dbState.admins = [];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.resetModules();
    dbState.admins = [];
  });

  it("returns 400 when credentials are missing from the request body", async () => {
    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {},
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/username|password/i);

    await server.close();
  });

  it("returns 503 when no admin is configured in the database", async () => {
    const originalUsername = process.env.ADMIN_USERNAME;
    const originalPassword = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    // ALLOW_ADMIN_SETUP=true so validateEnv doesn't throw on missing admin creds
    process.env.ALLOW_ADMIN_SETUP = "true";
    // dbState.admins is empty — no admin in DB

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "testpassword" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().setupRequired).toBe(true);

    await server.close();
    process.env.ADMIN_USERNAME = originalUsername;
    process.env.ADMIN_PASSWORD = originalPassword;
    delete process.env.ALLOW_ADMIN_SETUP;
  });

  it("returns 200 with token when credentials match a bcrypt-hashed password", async () => {
    // Generate a bcrypt hash and seed the mock DB with it
    const plainPassword = "securepassword99";
    const hashed = await bcrypt.hash(plainPassword, 10);

    process.env.ADMIN_USERNAME = "hashedadmin";
    process.env.ADMIN_PASSWORD = hashed;

    // Seed mock admin matching the credentials
    dbState.admins = [
      {
        id: "admin-1",
        username: "hashedadmin",
        passwordHash: hashed,
        role: "admin",
        active: true,
        setupConfirmed: false,
      },
    ];

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "hashedadmin", password: plainPassword },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("token");
    expect(response.json()).toHaveProperty("expiresIn");

    await server.close();
  });

  it("returns 200 when credentials match a password stored in the database", async () => {
    // Passwords are always bcrypt-hashed when stored in the DB (bootstrap hashes them).
    // This test verifies the DB-backed login flow end to end.
    const plainPassword = "plaintextpass123";
    const hashed = await bcrypt.hash(plainPassword, 10);

    process.env.ADMIN_USERNAME = "devadmin";
    process.env.ADMIN_PASSWORD = plainPassword;

    dbState.admins = [
      {
        id: "admin-1",
        username: "devadmin",
        passwordHash: hashed,
        role: "admin",
        active: true,
        setupConfirmed: false,
      },
    ];

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "devadmin", password: plainPassword },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("token");

    await server.close();
  });

  it("returns 500 when JWT signing fails because JWT_SECRET is absent at request time", async () => {
    // Build the server with a valid JWT_SECRET so validateEnv passes, then remove it
    // before the request so signJwt throws — exercising the catch block.
    const plainPassword = "testpassword";
    const hashed = await bcrypt.hash(plainPassword, 10);

    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = plainPassword;

    dbState.admins = [
      {
        id: "admin-1",
        username: "admin",
        passwordHash: hashed,
        role: "admin",
        active: true,
        setupConfirmed: false,
      },
    ];

    const server = await createServer();

    const originalSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: plainPassword },
      headers: { "content-type": "application/json" },
    });

    process.env.JWT_SECRET = originalSecret;

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatch(/authentication error/i);

    await server.close();
  });
});

describe("GET /api/v1/auth/setup/status", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    dbState.admins = [];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.resetModules();
    dbState.admins = [];
  });

  it("returns requiresSetup=true when no admins exist in the database", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    // dbState.admins is empty

    const server = await createServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/auth/setup/status",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requiresSetup).toBe(true);
    expect(body.bootstrapPending).toBe(false);
    expect(body.adminConfigured).toBe(false);

    await server.close();
  });

  it("returns bootstrapPending=true when an admin exists with setupConfirmed=false", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    dbState.admins = [
      {
        id: "admin-1",
        username: "bootstrap-admin",
        passwordHash: "$2b$10$placeholder",
        role: "admin",
        active: true,
        setupConfirmed: false,
      },
    ];

    const server = await createServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/auth/setup/status",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.bootstrapPending).toBe(true);
    expect(body.requiresSetup).toBe(false);
    expect(body.adminConfigured).toBe(false);

    await server.close();
  });

  it("returns adminConfigured=true when an admin exists with setupConfirmed=true", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    dbState.admins = [
      {
        id: "admin-1",
        username: "confirmed-admin",
        passwordHash: "$2b$10$placeholder",
        role: "admin",
        active: true,
        setupConfirmed: true,
      },
    ];

    const server = await createServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/auth/setup/status",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.adminConfigured).toBe(true);
    expect(body.requiresSetup).toBe(false);
    expect(body.bootstrapPending).toBe(false);

    await server.close();
  });
});

describe("POST /api/v1/auth/confirm-bootstrap", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    dbState.admins = [];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.resetModules();
    dbState.admins = [];
  });

  it("returns 400 when username and password are missing from the body", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: {},
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/username|password/i);

    await server.close();
  });

  it("returns 400 when password is shorter than 8 characters", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: { username: "admin", password: "short" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/8 characters/i);

    await server.close();
  });

  it("returns 400 when no bootstrap admin exists in the database", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    // dbState.admins is empty

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: { username: "admin", password: "newpassword123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("No bootstrap admin found");

    await server.close();
  });

  it("returns 400 when the bootstrap admin has already been confirmed", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    dbState.admins = [
      {
        id: "admin-1",
        username: "admin",
        passwordHash: "$2b$10$placeholder",
        role: "admin",
        active: true,
        setupConfirmed: true,
      },
    ];

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: { username: "admin", password: "newpassword123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Bootstrap already confirmed");

    await server.close();
  });

  it("returns 200, marks admin confirmed, and updates credentials on success", async () => {
    process.env.ALLOW_ADMIN_SETUP = "true";
    dbState.admins = [
      {
        id: "admin-1",
        username: "bootstrap-admin",
        passwordHash: "$2b$10$placeholder",
        role: "admin",
        active: true,
        setupConfirmed: false,
      },
    ];

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/confirm-bootstrap",
      payload: { username: "newadmin", password: "securepassword123" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe("Admin credentials confirmed");
    expect(dbState.admins[0].setupConfirmed).toBe(true);
    expect(dbState.admins[0].username).toBe("newadmin");
    expect(dbState.admins[0].passwordHash).toMatch(/^\$2[aby]\$/);

    await server.close();
  });
});
