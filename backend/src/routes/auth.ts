import { existsSync, writeFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { signJwt } from "../lib/auth";
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

export function validateAdminPasswordConfig(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
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
  const isHashed = validateAdminPasswordConfig();
  if (!isHashed && process.env.ADMIN_PASSWORD) {
    fastify.log.warn(
      "DEPRECATION WARNING: ADMIN_PASSWORD is stored in plaintext. " +
        "This is insecure and will cause startup failure in production mode. " +
        "Please use a bcrypt hash instead."
    );
  }

  fastify.get("/auth/setup/status", async (_request, reply) => {
    const allowAdminSetup = process.env.ALLOW_ADMIN_SETUP === "true";
    const adminConfigured = !!process.env.ADMIN_PASSWORD;
    const setupAllowed = allowAdminSetup && !adminConfigured && !setupUsed;

    return reply.code(200).send({
      setupAllowed,
      adminConfigured,
    });
  });

  fastify.post(
    "/auth/setup",
    {
      preHandler: rateLimit({ max: 3, windowMs: 15 * 60 * 1000 }), // 3 requests per 15 minutes
    },
    async (request, reply) => {
      const allowAdminSetup = process.env.ALLOW_ADMIN_SETUP === "true";
      const adminConfigured = !!process.env.ADMIN_PASSWORD;

      if (!allowAdminSetup) {
        return reply.code(403).send({ error: "Admin setup is not enabled" });
      }

      if (adminConfigured) {
        return reply.code(403).send({ error: "Admin is already configured" });
      }

      if (setupUsed) {
        return reply.code(403).send({ error: "Setup has already been used this session" });
      }

      if (setupInProgress) {
        return reply.code(409).send({ error: "Setup is already in progress" });
      }

      setupInProgress = true;

      try {
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

        if (!username || !password) {
          return reply.code(400).send({ error: "Username and password are required" });
        }

        if (password.length < 8) {
          return reply.code(400).send({ error: "Password must be at least 8 characters" });
        }

        let passwordHash: string;
        try {
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
            "2. Add to your environment configuration:",
            `   ADMIN_USERNAME=${username}`,
            `   ADMIN_PASSWORD=${passwordHash}`,
            "3. Remove or set ALLOW_ADMIN_SETUP=false",
            "4. Restart your application",
          ],
        });
      } finally {
        setupInProgress = false;
      }
    }
  );

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

      const adminUsername = process.env.ADMIN_USERNAME;
      const adminPassword = process.env.ADMIN_PASSWORD;

      if (!adminUsername || !adminPassword) {
        fastify.log.error("Admin credentials not configured in environment");
        return reply.code(500).send({ error: "Server configuration error" });
      }

      let isValid = false;

      if (username === adminUsername) {
        if (adminPassword.match(/^\$2[aby]\$/)) {
          isValid = await bcrypt.compare(password, adminPassword);
        } else {
          fastify.log.warn(
            "DEPRECATION WARNING: ADMIN_PASSWORD is stored in plaintext. " +
              "This is insecure and will be removed in a future version. " +
              "Please use a bcrypt hash instead. Generate one with: " +
              "node -e \"console.log(require('bcryptjs').hashSync('your-password', 10))\""
          );
          isValid = password === adminPassword;
        }
      }

      if (!isValid) {
        fastify.log.warn({ username }, "Failed login attempt");
        return reply.code(401).send({ error: "Invalid credentials" });
      }

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
