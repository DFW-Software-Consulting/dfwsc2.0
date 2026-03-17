import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Admin Setup Integration Tests
 *
 * NOTE: These tests use the vitest environment defined in vitest.config.ts.
 * Full E2E testing of the setup flow should be done in the Docker environment.
 *
 * The tests focus on guard conditions and state transitions.
 */

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

describe("Admin Setup Integration", () => {
  beforeEach(() => {
    dbState.admins = [];
    vi.resetModules();
  });

  afterEach(async () => {
    dbState.admins = [];
    vi.resetModules();
    // Reset the setupUsed flag after each test
    const authModule = await import("../../routes/auth");
    authModule.resetSetupState();
  });

  async function createServer() {
    vi.resetModules();
    const rateLimitModule = await import("../../lib/rate-limit");
    if (rateLimitModule.hitBuckets) {
      rateLimitModule.hitBuckets.clear();
    }
    vi.resetModules();
    const authModule = await import("../../routes/auth");
    authModule.resetSetupState();
    vi.resetModules();
    const { buildServer } = await import("../../app");
    return buildServer();
  }

  describe("GET /auth/setup/status", () => {
    it("should return requiresSetup=true when no admin is in the database", async () => {
      delete process.env.ALLOW_ADMIN_SETUP;
      // dbState.admins is empty
      const server = await createServer();

      const response = await server.inject({
        method: "GET",
        url: "/api/v1/auth/setup/status",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.requiresSetup).toBe(true);
      expect(body.adminConfigured).toBe(false);
      expect(body.bootstrapPending).toBe(false);

      await server.close();
    });

    it("should return adminConfigured=true when a setup-confirmed admin exists in DB", async () => {
      // Seed a confirmed admin
      dbState.admins = [
        {
          id: "admin-1",
          username: "admin",
          passwordHash: "$2a$10$example",
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
      expect(body.bootstrapPending).toBe(false);
      expect(body.requiresSetup).toBe(false);

      await server.close();
    });

    it("should return bootstrapPending=true when admin exists but not yet confirmed", async () => {
      dbState.admins = [
        {
          id: "admin-1",
          username: "admin",
          passwordHash: "$2a$10$example",
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
      expect(body.adminConfigured).toBe(false);
      expect(body.requiresSetup).toBe(false);

      await server.close();
    });
  });

  describe("POST /auth/setup - guards", () => {
    it("should return 403 when ALLOW_ADMIN_SETUP is not enabled", async () => {
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

    it("should return 403 when admin is already configured", async () => {
      // Seed a confirmed admin to trigger the guard
      dbState.admins = [
        {
          id: "admin-1",
          username: "admin",
          passwordHash: "$2a$10$example",
          role: "admin",
          active: true,
          setupConfirmed: true,
        },
      ];
      process.env.ALLOW_ADMIN_SETUP = "true";
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
  });

  describe("resetSetupState function", () => {
    it("should export resetSetupState function for testing", async () => {
      const authModule = await import("../../routes/auth");
      expect(typeof authModule.resetSetupState).toBe("function");
    });
  });
});
