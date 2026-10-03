import crypto from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { type DbOrTx, db } from "../db/client";
import { apiKeyRegenerationTokens, clients } from "../db/schema";
import { hashApiKey, sha256Lookup } from "./auth";
import { errors } from "./errors";

const REGENERATION_TOKEN_TTL_MS = 15 * 60 * 1000;
// A client with a pending token younger than this is not issued another one by the
// public self-service request, so an outsider cannot flood the inbox or revoke a
// fresh link (including the one in the welcome email).
const REGENERATION_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createRegenerationToken(
  {
    clientId,
    email,
  }: {
    clientId: string;
    email: string;
  },
  dbOrTx: DbOrTx = db
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  await dbOrTx.transaction(async (tx) => {
    await tx
      .update(apiKeyRegenerationTokens)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(
        and(
          eq(apiKeyRegenerationTokens.clientId, clientId),
          eq(apiKeyRegenerationTokens.status, "pending")
        )
      );

    await tx.insert(apiKeyRegenerationTokens).values({
      id: uuidv4(),
      clientId,
      token: tokenHash,
      status: "pending",
      email,
    });
  });

  return rawToken;
}

/**
 * Self-service variant of createRegenerationToken: returns null, and leaves the
 * existing pending token untouched, when the client already has one younger than the
 * cooldown. The client row is locked so concurrent requests cannot both pass the check.
 */
export async function createRegenerationTokenUnlessRecent(
  { clientId, email }: { clientId: string; email: string },
  dbOrTx: DbOrTx = db
): Promise<string | null> {
  return dbOrTx.transaction(async (tx) => {
    await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).for("update");

    const [recent] = await tx
      .select({ id: apiKeyRegenerationTokens.id })
      .from(apiKeyRegenerationTokens)
      .where(
        and(
          eq(apiKeyRegenerationTokens.clientId, clientId),
          eq(apiKeyRegenerationTokens.status, "pending"),
          gt(
            apiKeyRegenerationTokens.createdAt,
            new Date(Date.now() - REGENERATION_REQUEST_COOLDOWN_MS)
          )
        )
      )
      .limit(1);

    if (recent) return null;

    return createRegenerationToken({ clientId, email }, tx);
  });
}

export async function validateAndRegenerate(rawToken: string): Promise<string> {
  const tokenHash = hashToken(rawToken);

  const [record] = await db
    .select()
    .from(apiKeyRegenerationTokens)
    .where(eq(apiKeyRegenerationTokens.token, tokenHash))
    .limit(1);

  if (!record) {
    throw errors.notFound("Regeneration link");
  }

  if (record.status === "revoked") {
    throw errors.badRequest("This regeneration link has been invalidated.");
  }

  if (record.status === "completed") {
    throw errors.badRequest("This regeneration link has already been used.");
  }

  if (record.status !== "pending") {
    throw errors.badRequest("Invalid regeneration link.");
  }

  const createdAt = record.createdAt ? new Date(record.createdAt) : null;
  if (createdAt && Date.now() - createdAt.getTime() > REGENERATION_TOKEN_TTL_MS) {
    throw errors.badRequest("This regeneration link has expired.");
  }

  let newApiKey: string | undefined;

  await db.transaction(async (tx) => {
    const [completedToken] = await tx
      .update(apiKeyRegenerationTokens)
      .set({ status: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(apiKeyRegenerationTokens.id, record.id),
          eq(apiKeyRegenerationTokens.status, "pending")
        )
      )
      .returning({ clientId: apiKeyRegenerationTokens.clientId });

    if (!completedToken) {
      throw errors.badRequest("This regeneration link has already been used.");
    }

    newApiKey = crypto.randomBytes(32).toString("hex");
    const newApiKeyHash = await hashApiKey(newApiKey);
    const newApiKeyLookup = sha256Lookup(newApiKey);

    await tx
      .update(clients)
      .set({
        apiKeyHash: newApiKeyHash,
        apiKeyLookup: newApiKeyLookup,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, completedToken.clientId));
  });

  if (!newApiKey) {
    throw errors.badRequest("This regeneration link has already been used.");
  }

  return newApiKey;
}
