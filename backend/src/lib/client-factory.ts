import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import validator from "validator";
import { type DbOrTx, db } from "../db/client";
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

export interface PreparedClientWithOnboardingToken {
  clientId: string;
  apiKey: string;
  token: string;
  onboardingTokenId: string;
  client: typeof clients.$inferInsert;
  onboardingToken: typeof onboardingTokens.$inferInsert;
}

export async function prepareClientWithOnboardingToken({
  name,
  email,
  workspace,
  groupId,
}: CreateClientWithOnboardingTokenOptions): Promise<PreparedClientWithOnboardingToken> {
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

  const token = crypto.randomBytes(32).toString("hex");
  const tokenLookup = hashOnboardingToken(token);
  const onboardingTokenId = uuidv4();

  return {
    clientId,
    apiKey,
    token,
    onboardingTokenId,
    client: {
      id: clientId,
      workspace,
      name,
      email,
      apiKeyHash,
      apiKeyLookup,
      ...(groupId ? { groupId } : {}),
    },
    onboardingToken: {
      id: onboardingTokenId,
      clientId,
      token: tokenLookup,
      status: "pending",
      email,
    },
  };
}

/**
 * Read-only duplicate check, run before external side effects (e.g. Stripe account creation).
 * The `clients_email_workspace_unique` constraint stays authoritative at insert time.
 */
export async function assertClientEmailAvailable(
  email: string,
  workspace: Workspace,
  dbOrTx: DbOrTx = db
): Promise<void> {
  const [existing] = await dbOrTx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.email, email), eq(clients.workspace, workspace)))
    .limit(1);
  if (existing) {
    throw errors.conflict("A client with this email already exists.");
  }
}

export async function persistPreparedClientWithOnboardingToken(
  prepared: PreparedClientWithOnboardingToken,
  dbOrTx: DbOrTx = db
): Promise<void> {
  const { client, onboardingToken } = prepared;

  if (client.groupId) {
    const [group] = await dbOrTx
      .select({ id: clientGroups.id, workspace: clientGroups.workspace })
      .from(clientGroups)
      .where(eq(clientGroups.id, client.groupId))
      .limit(1);
    if (!group) {
      throw Object.assign(new Error("Invalid groupId."), { statusCode: 400 });
    }
    if (group.workspace !== client.workspace) {
      throw Object.assign(new Error("groupId workspace does not match client workspace."), {
        statusCode: 400,
      });
    }
  }

  try {
    await dbOrTx.transaction(async (tx) => {
      await tx.insert(clients).values(client);
      await tx.insert(onboardingTokens).values(onboardingToken);
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
}

export async function createClientWithOnboardingToken(
  options: CreateClientWithOnboardingTokenOptions,
  dbOrTx: DbOrTx = db
): Promise<PreparedClientWithOnboardingToken> {
  const prepared = await prepareClientWithOnboardingToken(options);
  await persistPreparedClientWithOnboardingToken(prepared, dbOrTx);
  return prepared;
}
