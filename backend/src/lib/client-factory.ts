import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import validator from "validator";
import { db } from "../db/client";
import { clientGroups, clients, onboardingTokens } from "../db/schema";
import { hashApiKey, sha256Lookup } from "./auth";
import { dbErrorConstraint, errors, isUniqueViolation } from "./errors";
import type { Workspace } from "./workspace";

function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashOnboardingToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

interface CreateClientWithOnboardingTokenOptions {
  name: string;
  email: string;
  workspace: Workspace;
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
  workspace,
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

  if (groupId) {
    const [group] = await db
      .select({ id: clientGroups.id, workspace: clientGroups.workspace })
      .from(clientGroups)
      .where(eq(clientGroups.id, groupId))
      .limit(1);
    if (!group) {
      throw Object.assign(new Error("Invalid groupId."), { statusCode: 400 });
    }
    if (group.workspace !== workspace) {
      throw Object.assign(new Error("groupId workspace does not match client workspace."), {
        statusCode: 400,
      });
    }
  }

  const clientId = uuidv4();
  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const apiKeyLookup = sha256Lookup(apiKey);

  const token = crypto.randomBytes(32).toString("hex");
  const tokenLookup = hashOnboardingToken(token);
  const onboardingTokenId = uuidv4();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(clients).values({
        id: clientId,
        workspace,
        name,
        email,
        apiKeyHash,
        apiKeyLookup,
        ...(groupId ? { groupId } : {}),
      });

      await tx.insert(onboardingTokens).values({
        id: onboardingTokenId,
        clientId,
        token: tokenLookup,
        status: "pending",
        email,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const constraint = dbErrorConstraint(err);
      if (constraint?.includes("email")) {
        throw errors.conflict("A client with this email already exists.");
      }
      throw errors.conflict("A client with these details already exists.");
    }
    throw err;
  }

  return { clientId, apiKey, token };
}
