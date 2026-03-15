import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { db } from "../db/client";
import { clients } from "../db/schema";

export function sha256Lookup(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export async function requireApiKey(request: FastifyRequest, reply: FastifyReply) {
  const apiKeyHeader = request.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return reply.code(401).send({ error: "API key is required." });
  }

  try {
    const lookup = sha256Lookup(apiKey);
    const [clientByLookup] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.apiKeyLookup, lookup), eq(clients.status, "active")))
      .limit(1);

    if (clientByLookup) {
      const isValid = clientByLookup.apiKeyHash
        ? await verifyPassword(apiKey, clientByLookup.apiKeyHash)
        : false;
      if (isValid) {
        (request as FastifyRequest & { client?: typeof clients.$inferSelect }).client =
          clientByLookup;
        return;
      }
      return reply.code(401).send({ error: "Invalid API key." });
    }

    // Legacy fallback for clients not yet migrated to apiKeyLookup
    const legacyClients = await db.select().from(clients).where(isNull(clients.apiKeyLookup));

    for (const client of legacyClients) {
      if (client.apiKeyHash) {
        const isValid = await verifyPassword(apiKey, client.apiKeyHash);
        if (isValid && client.status !== "inactive") {
          (request as FastifyRequest & { client?: typeof clients.$inferSelect }).client = client;
          return;
        }
      }
    }

    return reply.code(401).send({ error: "Invalid API key." });
  } catch (error) {
    request.log.error({ error }, "Error in requireApiKey");
    return reply.code(500).send({ error: "Internal server error during API key validation." });
  }
}

export async function hashApiKey(apiKey: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(apiKey, saltRounds);
}

export async function verifyPassword(plaintext: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hashed);
}

export function signJwt(payload: { role: string }): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  const expiresIn = process.env.JWT_EXPIRY || "1h";
  return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
}

export async function requireAdminJwt(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return reply.code(401).send({ error: "Authorization header required" });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return reply
      .code(401)
      .send({ error: "Invalid authorization header format. Expected: Bearer <token>" });
  }

  const token = parts[1];

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("JWT_SECRET is not configured");
    }

    const decoded = jwt.verify(token, secret) as jwt.JwtPayload & { role: string };

    if (decoded.role !== "admin") {
      return reply.code(403).send({ error: "Forbidden: Admin role required" });
    }
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return reply.code(401).send({ error: "Token expired" });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return reply.code(401).send({ error: "Invalid token" });
    }
    return reply.code(401).send({ error: "Authentication failed" });
  }
}
