import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { admins } from "../db/schema";
import { getAdminFromDb, requireAdminJwt, signJwt } from "../lib/auth";
import { rateLimit } from "../lib/rate-limit";

const MIN_ADMIN_PASSWORD_LENGTH = 12;

// A fixed, valid bcrypt hash used to equalize response timing when the supplied
// username does not correspond to any admin. It is never expected to match any
// real password (it is a hash of a random throwaway value).
const DUMMY_PASSWORD_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8Dq1nBQF1p1Q7B0k6QhE5jQ8hEo1Wa";

function validateAdminPassword(pw: string): string | null {
  if (pw.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

interface LoginRequest {
  username: string;
  password: string;
}

// For testing purposes only. The deprecated /auth/setup handler no longer holds
// any setup state, so this is now a no-op retained for backward compatibility
// with existing test suites that import it.
export function resetSetupState(): void {
  // no-op
}

export default async function authRoutes(fastify: FastifyInstance) {
  // GET /auth/setup/status - Returns DB-aware setup state.
  // Note: bootstrapPending is intentionally NOT exposed to unauthenticated
  // callers — it would let an anonymous caller detect a live bootstrap
  // window and target the confirm-bootstrap flow.
  fastify.get("/auth/setup/status", async (_request, reply) => {
    const allAdmins = await db.select().from(admins);
    const firstAdmin = allAdmins[0];

    const adminConfigured = allAdmins.length > 0 && !!firstAdmin.setupConfirmed;
    const requiresSetup = allAdmins.length === 0;

    return reply.code(200).send({
      adminConfigured,
      requiresSetup,
    });
  });

  // POST /auth/setup - Deprecated. This legacy handler never actually created an
  // admin (it only hashed a password) yet it consumed the one-time setup flag,
  // making it a misleading soft-DoS vector. The real bootstrap path is env
  // ADMIN_USERNAME/ADMIN_PASSWORD followed by POST /auth/confirm-bootstrap.
  // Returns 410 Gone without mutating any setup state.
  fastify.post(
    "/auth/setup",
    {
      preHandler: rateLimit({ max: 3, windowMs: 15 * 60 * 1000 }), // 3 requests per 15 minutes
    },
    async (_request, reply) => {
      return reply.code(410).send({
        error:
          "This setup endpoint is deprecated. Bootstrap the first admin via ADMIN_USERNAME/ADMIN_PASSWORD env vars, then POST /auth/confirm-bootstrap.",
      });
    }
  );

  // POST /auth/confirm-bootstrap - Finalize admin credentials after first login
  fastify.post(
    "/auth/confirm-bootstrap",
    {
      // Requires an authenticated admin JWT (obtained via /auth/login with the
      // bootstrap password) so an anonymous caller can no longer finalize
      // admin credentials.
      preHandler: [requireAdminJwt, rateLimit({ max: 3, windowMs: 15 * 60 * 1000 })],
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as Partial<LoginRequest>;
      const { username, password } = body;

      if (!username || !password) {
        return reply.code(400).send({ error: "Username and password are required" });
      }

      const passwordError = validateAdminPassword(password);
      if (passwordError) {
        return reply.code(400).send({ error: passwordError });
      }

      const allAdmins = await db.select().from(admins);
      const firstAdmin = allAdmins[0];

      if (!firstAdmin) {
        return reply.code(400).send({ error: "No bootstrap admin found" });
      }

      if (firstAdmin.setupConfirmed) {
        return reply.code(400).send({ error: "Bootstrap already confirmed" });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      await db
        .update(admins)
        .set({
          username,
          passwordHash,
          setupConfirmed: true,
          updatedAt: new Date(),
        })
        .where(and(eq(admins.id, firstAdmin.id), eq(admins.setupConfirmed, false)));

      fastify.log.info({ username }, "Admin bootstrap confirmed");

      return reply.code(200).send({ message: "Admin credentials confirmed" });
    }
  );

  // POST /auth/login - Admin login endpoint (queries DB)
  fastify.post(
    "/auth/login",
    {
      preHandler: rateLimit({ max: 5, windowMs: 15 * 60 * 1000 }), // 5 requests per 15 minutes
    },
    async (request, reply) => {
      const { username, password } = request.body as LoginRequest;

      if (!username || !password) {
        return reply.code(400).send({ error: "Username and password are required" });
      }

      const admin = await getAdminFromDb(username);

      // Return an identical generic 401 for both "no such admin" and "bad
      // password" to avoid username enumeration. When the admin is missing we
      // still run a bcrypt comparison against a fixed dummy hash so the response
      // time does not reveal whether the username exists (timing oracle).
      // The dedicated GET /auth/setup/status route is the only place that
      // exposes the "setup required" signal.
      if (!admin) {
        await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
        fastify.log.warn({ username }, "Failed login attempt (unknown user)");
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const isValid = await bcrypt.compare(password, admin.passwordHash);

      if (!isValid) {
        fastify.log.warn({ username }, "Failed login attempt");
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      if (admin.active === false) {
        fastify.log.warn({ username }, "Login attempt for deactivated admin");
        return reply.code(403).send({ error: "Account is deactivated" });
      }

      // Generate JWT token
      try {
        const token = signJwt({ role: "admin", sub: admin.id });
        const expiresIn = process.env.JWT_EXPIRY || "1h";

        fastify.log.info({ username }, "Successful admin login");

        return reply.code(200).send({
          token,
          expiresIn,
          bootstrapPending: admin.setupConfirmed !== true,
        });
      } catch (error) {
        fastify.log.error({ error }, "Error generating JWT token");
        return reply.code(500).send({ error: "Authentication error" });
      }
    }
  );
}
