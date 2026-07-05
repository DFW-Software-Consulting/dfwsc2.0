import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { apiKeyRegenerationTokens, clients } from "../db/schema";
import { hashApiKey, sha256Lookup } from "./auth";
import { errors } from "./errors";

const REGENERATION_TOKEN_TTL_MS = 15 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createRegenerationToken({
  clientId,
  email,
}: {
  clientId: string;
  email: string;
}): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  await db.transaction(async (tx) => {
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

  const newApiKey = crypto.randomBytes(32).toString("hex");
  const newApiKeyHash = await hashApiKey(newApiKey);
  const newApiKeyLookup = sha256Lookup(newApiKey);

  await db.transaction(async (tx) => {
    await tx
      .update(clients)
      .set({
        apiKeyHash: newApiKeyHash,
        apiKeyLookup: newApiKeyLookup,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, record.clientId));

    await tx
      .update(apiKeyRegenerationTokens)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(apiKeyRegenerationTokens.id, record.id));
  });

  return newApiKey;
}
