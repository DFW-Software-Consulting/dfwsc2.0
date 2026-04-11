import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import validator from "validator";
import { db } from "../db/client";
import { clients, onboardingTokens } from "../db/schema";
import { hashApiKey, sha256Lookup } from "./auth";

function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

interface CreateClientWithOnboardingTokenOptions {
  name: string;
  email: string;
  stripeCustomerId?: string;
  groupId?: string;
}

interface ClientWithToken {
  clientId: string;
  apiKey: string;
  token: string;
}

export async function createClientWithOnboardingToken({
  name,
  email,
  stripeCustomerId,
  groupId,
}: CreateClientWithOnboardingTokenOptions): Promise<ClientWithToken> {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw Object.assign(new Error("Name is required and must be a non-empty string"), {
      statusCode: 400,
    });
  }

  if (!email || typeof email !== "string" || !validator.isEmail(email)) {
    throw Object.assign(new Error("Valid email is required"), { statusCode: 400 });
  }

  const clientId = uuidv4();
  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const apiKeyLookup = sha256Lookup(apiKey);

  await db.insert(clients).values({
    id: clientId,
    name,
    email,
    apiKeyHash,
    apiKeyLookup,
    ...(stripeCustomerId ? { stripeCustomerId } : {}),
    ...(groupId ? { groupId } : {}),
  });

  const token = crypto.randomBytes(32).toString("hex");
  const onboardingTokenId = uuidv4();

  try {
    await db.insert(onboardingTokens).values({
      id: onboardingTokenId,
      clientId,
      token,
      status: "pending",
      email,
    });
  } catch (error) {
    try {
      await db.delete(clients).where(eq(clients.id, clientId));
    } catch {
      // Preserve original error from token insertion.
    }
    throw error;
  }

  return { clientId, apiKey, token };
}
