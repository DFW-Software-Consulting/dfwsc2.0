import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { checkAdminLogin } from "../lib/admin-login";
import { signJwt } from "../lib/auth";
import {
  AUTH_RATE_LIMIT_MAX,
  AUTH_RATE_LIMIT_WINDOW_MS,
  AUTH_USER_RATE_LIMIT_MAX,
} from "../lib/constants";
import { errors } from "../lib/errors";
import { rateLimit } from "../lib/rate-limit";
import { parseBody } from "../lib/validation";

interface LoginRequest {
  username: string;
  password: string;
}

const credentialsSchema = z.object({
  username: z
    .string({ error: "Username and password are required" })
    .min(1, "Username and password are required"),
  password: z
    .string({ error: "Username and password are required" })
    .min(1, "Username and password are required"),
});

// Bucket key for the per-username limiter: the submitted username, trimmed and lower-cased, as a
// SHA-256 so that long or odd input cannot bloat the in-memory map or the Redis keyspace. A body
// without a usable username shares one bucket (and is rejected with 400 by the handler anyway).
function usernameBucket(request: FastifyRequest): string {
  const username = (request.body as { username?: unknown } | null | undefined)?.username;
  const normalized = typeof username === "string" ? username.trim().toLowerCase() : "";
  return createHash("sha256").update(normalized).digest("hex");
}

export default async function authRoutes(fastify: FastifyInstance) {
  // POST /auth/login - Admin login. Credentials are checked against Nextcloud and the account
  // must belong to one of ADMIN_NEXTCLOUD_GROUPS (see lib/admin-login.ts).
  fastify.post(
    "/auth/login",
    {
      preHandler: [
        // Per client IP, and per username across all IPs. Nextcloud throttles failed logins by
        // source IP, which for these checks is this API, so unthrottled guessing here would
        // also slow the service account's automation calls.
        rateLimit({ max: AUTH_RATE_LIMIT_MAX, windowMs: AUTH_RATE_LIMIT_WINDOW_MS }),
        rateLimit({
          max: AUTH_USER_RATE_LIMIT_MAX,
          windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
          name: "POST:/auth/login:username",
          keyGenerator: usernameBucket,
        }),
      ],
    },
    async (request, reply) => {
      const body = parseBody(credentialsSchema, request.body, reply) as LoginRequest | null;
      if (!body) return;
      const username = body.username.trim();
      const { password } = body;

      const result = await checkAdminLogin(username, password, fastify.log);

      if (!result.ok) {
        if (result.reason === "unavailable") {
          throw errors.unavailable("Admin login is unavailable");
        }
        if (result.reason === "not_authorized") {
          fastify.log.warn({ username }, "Admin login refused: account not in an allowed group");
          throw errors.forbidden("This Nextcloud account isn't authorized for the admin panel");
        }
        fastify.log.warn({ username }, "Failed login attempt");
        throw errors.unauthorized("Invalid credentials");
      }

      try {
        const token = signJwt({ role: "admin", sub: result.userId });
        const expiresIn = process.env.JWT_EXPIRY || "1h";

        fastify.log.info({ username: result.userId }, "Successful admin login");

        return reply.code(200).send({ token, expiresIn });
      } catch (error) {
        fastify.log.error({ error }, "Error generating JWT token");
        throw errors.internal("Authentication error");
      }
    }
  );
}
