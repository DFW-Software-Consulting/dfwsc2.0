import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { admins } from "../db/schema";
import { getAdminFromDb, signJwt } from "../lib/auth";
import { rateLimit } from "../lib/rate-limit";

const SETUP_FLAG_FILE = process.env.SETUP_FLAG_PATH ?? "/tmp/admin-setup-used";

interface LoginRequest {
  username: string;
  password: string;
}

interface SetupRequest {
  username: string;
  password: string;
}

/**
 * Validates that ADMIN_PASSWORD is bcrypt-hashed in production mode.
 * Throws an error if NODE_ENV=production and password is plaintext.
 * Returns true if validation passes, false if warning-only (dev mode).
 */
export function validateAdminPasswordConfig(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    // No password set - this will be caught during login attempt
    return true;
  }

  const isBcryptHash = /^\$2[aby]\$/.test(adminPassword);

  if (nodeEnv === "production" && !isBcryptHash) {
    throw new Error(
      "SECURITY ERROR: ADMIN_PASSWORD must be a bcrypt hash in production mode. " +
        "Plaintext passwords are not allowed. Generate a hash with: " +
        "node -e \"console.log(require('bcryptjs').hashSync('your-password', 10))\""
    );
  }

  return isBcryptHash;
}

// Persisted flag: survives restarts if SETUP_FLAG_PATH points to a mounted volume
let setupUsed = existsSync(SETUP_FLAG_FILE);
let setupInProgress = false;

// For testing purposes only - reset the setup state
export function resetSetupState(): void {
  setupUsed = false;
}

export default async function authRoutes(fastify: FastifyInstance) {
  // Validate admin password configuration on route registration
  if (process.env.ADMIN_PASSWORD) {
    const isHashed = validateAdminPasswordConfig();
    if (!isHashed) {
      fastify.log.warn(
        "DEPRECATION WARNING: ADMIN_PASSWORD is stored in plaintext. " +
          "This is insecure and will cause startup failure in production mode. " +
          "Please use a bcrypt hash instead."
      );
    }
  }

  // GET /auth/setup/status - Returns DB-aware bootstrap/setup state
  fastify.get("/auth/setup/status", async (_request, reply) => {
    const allAdmins = await db.select().from(admins);
    const firstAdmin = allAdmins[0];

    const bootstrapPending = allAdmins.length > 0 && !firstAdmin.setupConfirmed;
    const adminConfigured = allAdmins.length > 0 && !!firstAdmin.setupConfirmed;
    const requiresSetup = allAdmins.length === 0;

    return reply.code(200).send({
      bootstrapPending,
      adminConfigured,
      requiresSetup,
    });
  });

  // POST /auth/setup - One-time admin credential setup (legacy, kept for backward compat)
  fastify.post(
    "/auth/setup",
    {
      preHandler: rateLimit({ max: 3, windowMs: 15 * 60 * 1000 }), // 3 requests per 15 minutes
    },
    async (request, reply) => {
      const allowAdminSetup = process.env.ALLOW_ADMIN_SETUP === "true";
      const allAdmins = await db.select().from(admins);
      const adminConfiguredInDb = allAdmins.length > 0;
      const adminConfiguredInEnv = !!process.env.ADMIN_PASSWORD;

      // Check if setup is allowed
      if (!allowAdminSetup) {
        return reply.code(403).send({ error: "Admin setup is not enabled" });
      }

      if (adminConfiguredInDb || adminConfiguredInEnv) {
        return reply.code(403).send({ error: "Admin is already configured" });
      }

      if (setupUsed) {
        return reply.code(403).send({ error: "Setup has already been used this session" });
      }

      if (setupInProgress) {
        return reply.code(409).send({ error: "Setup is already in progress" });
      }

      // Block concurrent setup attempts after passing the one-time guard.
      setupInProgress = true;

      try {
        // Validate setup token if configured
        const setupToken = process.env.ADMIN_SETUP_TOKEN;
        if (setupToken) {
          const providedToken = request.headers["x-setup-token"];
          if (providedToken !== setupToken) {
            fastify.log.warn("Invalid setup token provided");
            return reply.code(401).send({ error: "Invalid setup token" });
          }
        }

        const body = (request.body ?? {}) as Partial<SetupRequest>;
        const { username, password } = body;

        // Validate request body
        if (!username || !password) {
          return reply.code(400).send({ error: "Username and password are required" });
        }

        if (password.length < 8) {
          return reply.code(400).send({ error: "Password must be at least 8 characters" });
        }

        let passwordHash: string;
        try {
          // Generate bcrypt hash
          const saltRounds = 10;
          passwordHash = await bcrypt.hash(password, saltRounds);

          // Persist flag so setup stays blocked across container restarts
          try {
            writeFileSync(SETUP_FLAG_FILE, "1");
          } catch {
            /* non-fatal */
          }
          setupUsed = true;
        } catch (error) {
          fastify.log.error({ error }, "Error generating admin password hash during setup");
          return reply.code(500).send({ error: "Setup failed" });
        }

        fastify.log.info({ username }, "Admin credentials generated via setup endpoint");

        return reply.code(200).send({
          username,
          passwordHash,
          instructions: [
            "1. Copy the credentials above",
            "2. (Recommended) Use these to login and follow the confirm-bootstrap flow",
            "3. (Legacy) Add to your environment configuration:",
            `   ADMIN_USERNAME=${username}`,
            `   ADMIN_PASSWORD=${passwordHash}`,
            "4. Remove or set ALLOW_ADMIN_SETUP=false",
            "5. Restart your application",
          ],
        });
      } finally {
        // Release in-progress lock even if the request fails early.
        setupInProgress = false;
      }
    }
  );

  // POST /auth/confirm-bootstrap - Finalize admin credentials after first login
  fastify.post(
    "/auth/confirm-bootstrap",
    {
      preHandler: rateLimit({ max: 3, windowMs: 15 * 60 * 1000 }), // 3 requests per 15 minutes
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as Partial<LoginRequest>;
      const { username, password } = body;

      if (!username || !password) {
        return reply.code(400).send({ error: "Username and password are required" });
      }

      if (password.length < 8) {
        return reply.code(400).send({ error: "Password must be at least 8 characters" });
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

      if (!admin) {
        fastify.log.warn({ username }, "Login attempt — no admin configured in DB");
        return reply.code(503).send({ error: "Admin not configured", setupRequired: true });
      }

      const isValid = await bcrypt.compare(password, admin.passwordHash);

      if (!isValid) {
        fastify.log.warn({ username }, "Failed login attempt");
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      // Generate JWT token
      try {
        const token = signJwt({ role: "admin" });
        const expiresIn = process.env.JWT_EXPIRY || "1h";

        fastify.log.info({ username }, "Successful admin login");

        return reply.code(200).send({
          token,
          expiresIn,
        });
      } catch (error) {
        fastify.log.error({ error }, "Error generating JWT token");
        return reply.code(500).send({ error: "Authentication error" });
      }
    }
  );
}
