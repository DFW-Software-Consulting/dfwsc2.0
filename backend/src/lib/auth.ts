import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { db } from "../db/client";
import { admins, clients } from "../db/schema";

export function sha256Lookup(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

// API keys are 256-bit random values and the lookup is the SHA-256 of the full
// key, so bcrypt is only a second check and costs ~40 ms of event-loop time per
// call. A successful verification is remembered briefly, keyed by the lookup and
// tied to the exact stored hash: the row (status and hash) is still loaded on
// every request, so a deactivated client, or a key that was regenerated (new
// lookup and new hash), is never accepted from the cache.
const VERIFIED_KEY_TTL_MS = 60_000;
const VERIFIED_KEY_MAX_ENTRIES = 1000;
const verifiedApiKeys = new Map<string, { hash: string; expiresAt: number }>();

function isVerifiedApiKey(lookup: string, hash: string): boolean {
  const entry = verifiedApiKeys.get(lookup);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now() || entry.hash !== hash) {
    verifiedApiKeys.delete(lookup);
    return false;
  }
  return true;
}

function rememberVerifiedApiKey(lookup: string, hash: string): void {
  if (verifiedApiKeys.size >= VERIFIED_KEY_MAX_ENTRIES) {
    const oldest = verifiedApiKeys.keys().next().value;
    if (oldest !== undefined) verifiedApiKeys.delete(oldest);
  }
  verifiedApiKeys.set(lookup, { hash, expiresAt: Date.now() + VERIFIED_KEY_TTL_MS });
}

// True when this exact key passed full verification within the last VERIFIED_KEY_TTL_MS. It is
// answered from memory (no database access) and says nothing about the client's current status:
// callers must still run requireApiKey before trusting the key. It exists so a rate limiter can
// recognise a known-good key without a lookup.
export function isRecentlyVerifiedApiKey(apiKey: string): boolean {
  const lookup = sha256Lookup(apiKey);
  const entry = verifiedApiKeys.get(lookup);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    verifiedApiKeys.delete(lookup);
    return false;
  }
  return true;
}

// A key that matches no active client is remembered briefly, by lookup, so repeats are answered
// 401 without touching the database. Only a lookup that found no active client is recorded: a
// database error never is. It is a short-lived record, not a verdict: a client an admin has since
// reactivated is accepted again as soon as the record is cleared (forgetBadApiKey, called when an
// admin changes a client's status) or expires, whichever comes first, so BAD_API_KEY_TTL_MS is the
// longest a reactivated client can keep getting 401. A key that is valid is never affected: the
// record only exists for keys the database had no active client for.
const BAD_API_KEY_TTL_MS = 60_000;
const BAD_API_KEY_MAX_ENTRIES = 1000;
const badApiKeys = new Map<string, number>();

// Bumped by every forgetBadApiKey. A verification remembers the value it started under and does
// not record a "no active client" result if it has changed: its row may have been read just
// before the admin's status change, and recording it would undo the forget for up to
// BAD_API_KEY_TTL_MS. A single counter for all keys is enough: a forget only ever costs another
// key's in-flight verification one skipped record, never a wrong answer.
let badApiKeyGeneration = 0;

function isKnownBadApiKey(lookup: string): boolean {
  const expiresAt = badApiKeys.get(lookup);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    badApiKeys.delete(lookup);
    return false;
  }
  return true;
}

function rememberBadApiKey(lookup: string): void {
  // A key that was verified a moment ago and has no active client now must stop counting as
  // recently verified.
  verifiedApiKeys.delete(lookup);
  badApiKeys.delete(lookup);
  if (badApiKeys.size >= BAD_API_KEY_MAX_ENTRIES) {
    const oldest = badApiKeys.keys().next().value;
    if (oldest !== undefined) badApiKeys.delete(oldest);
  }
  badApiKeys.set(lookup, Date.now() + BAD_API_KEY_TTL_MS);
}

// Drops the record for a key's lookup so that key is checked against the database again. Call it
// when an admin changes a client's status.
export function forgetBadApiKey(lookup: string): void {
  badApiKeyGeneration += 1;
  badApiKeys.delete(lookup);
}

type ClientRow = typeof clients.$inferSelect;

// Concurrent requests carrying the same key share one verification (one row load, at most one
// bcrypt) instead of each running their own. The entry exists only while that verification is in
// flight, so a request that arrives after it settles starts a fresh one, and an error reaches
// every request that joined it.
const inFlightVerifications = new Map<string, Promise<ClientRow | null>>();

// The longest a shared verification may run. The database pool has no query timeout, so a stalled
// query would otherwise hold its map entry, and every later request for the same key, forever.
// When the time is up the entry is removed (later requests start a fresh lookup) and the requests
// waiting on it fail like any other database error.
const API_KEY_VERIFICATION_TIMEOUT_MS = 10_000;

class ApiKeyVerificationTimeoutError extends Error {
  constructor() {
    super(`API key verification did not finish within ${API_KEY_VERIFICATION_TIMEOUT_MS} ms`);
    this.name = "ApiKeyVerificationTimeoutError";
  }
}

type VerificationRun = {
  // badApiKeyGeneration when the verification started.
  generation: number;
  // Set when the timeout fired: whatever this run finds afterwards is out of date, and must not
  // be written to the bad-key record or the verification cache.
  expired: boolean;
};

async function verifyApiKey(
  apiKey: string,
  lookup: string,
  run: VerificationRun
): Promise<ClientRow | null> {
  const [clientByLookup] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.apiKeyLookup, lookup), eq(clients.status, "active")))
    .limit(1);

  // Out of date by now (see VerificationRun): nobody is waiting for this answer.
  if (run.expired) return null;

  if (!clientByLookup) {
    // Skip the record when this run is out of date or an admin cleared bad-key records since it
    // started: the client may have been reactivated after the row was read.
    if (!run.expired && run.generation === badApiKeyGeneration) rememberBadApiKey(lookup);
    return null;
  }

  const storedHash = clientByLookup.apiKeyHash;
  if (!storedHash) return null;
  if (isVerifiedApiKey(lookup, storedHash)) return clientByLookup;
  if (await verifyPassword(apiKey, storedHash)) {
    if (!run.expired) rememberVerifiedApiKey(lookup, storedHash);
    return clientByLookup;
  }
  return null;
}

function verifyApiKeyWithTimeout(apiKey: string, lookup: string): Promise<ClientRow | null> {
  const run: VerificationRun = { generation: badApiKeyGeneration, expired: false };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      run.expired = true;
      reject(new ApiKeyVerificationTimeoutError());
    }, API_KEY_VERIFICATION_TIMEOUT_MS);
    verifyApiKey(apiKey, lookup, run)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

export async function requireApiKey(request: FastifyRequest, reply: FastifyReply) {
  const apiKeyHeader = request.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return reply.code(401).send({ error: "API key is required." });
  }

  try {
    const lookup = sha256Lookup(apiKey);
    if (isKnownBadApiKey(lookup)) {
      return reply.code(401).send({ error: "Invalid API key." });
    }

    let verification = inFlightVerifications.get(lookup);
    if (!verification) {
      const started: Promise<ClientRow | null> = verifyApiKeyWithTimeout(apiKey, lookup).finally(
        () => {
          // Only this verification's own entry: after a timeout a newer one may own the key.
          if (inFlightVerifications.get(lookup) === started) inFlightVerifications.delete(lookup);
        }
      );
      verification = started;
      inFlightVerifications.set(lookup, started);
    }

    const client = await verification;
    if (client) {
      (request as FastifyRequest & { client?: ClientRow }).client = client;
      return;
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

export async function getAdminFromDb(username: string): Promise<{
  id: string;
  username: string;
  passwordHash: string;
  setupConfirmed: boolean | null;
  active: boolean | null;
} | null> {
  const [admin] = await db.select().from(admins).where(eq(admins.username, username)).limit(1);
  return admin ?? null;
}

export function signJwt(payload: { role: string; sub: string }): string {
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

    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] }) as jwt.JwtPayload & {
      role: string;
    };

    if (decoded.role !== "admin") {
      return reply.code(403).send({ error: "Forbidden: Admin role required" });
    }

    // Re-validate the admin against the DB so that deactivated or deleted
    // admins lose access immediately instead of remaining valid until the
    // token expires. Tokens issued by signJwt always carry `sub`; if `sub`
    // is absent we fall back to trusting the (validly signed) token.
    if (decoded.sub) {
      let adminRow: typeof admins.$inferSelect | undefined;
      try {
        [adminRow] = await db.select().from(admins).where(eq(admins.id, decoded.sub)).limit(1);
      } catch (dbError) {
        request.log.error({ dbError }, "Error validating admin session against DB");
        return reply.code(500).send({ error: "Internal server error" });
      }

      if (!adminRow || adminRow.active === false) {
        return reply.code(401).send({ error: "Account is not active" });
      }

      (request as any).admin = adminRow;
    } else {
      (request as any).admin = decoded;
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
