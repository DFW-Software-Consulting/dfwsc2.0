import crypto from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import he from "he";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db } from "../db/client";
import { apiKeyRegenerationTokens, clientGroups, clients, onboardingTokens } from "../db/schema";
import { createRegenerationToken, validateAndRegenerate } from "../lib/api-key-regeneration";
import { requireAdminJwt } from "../lib/auth";
import { withStripeCircuit } from "../lib/circuit-breakers";
import { createClientWithOnboardingToken, hashOnboardingToken } from "../lib/client-factory";
import { resolveFrontendOrigin, resolveServerBaseUrl } from "../lib/config";
import {
  AUTH_RATE_LIMIT_MAX,
  OAUTH_STATE_EXPIRY_MS,
  RATE_LIMIT_WINDOW_MS,
  STRICT_RATE_LIMIT_MAX,
} from "../lib/constants";
import { AppError, errors } from "../lib/errors";
import { sendMail } from "../lib/mailer";
import { rateLimit } from "../lib/rate-limit";
import { getSettings, stripe } from "../lib/stripe-billing";
import { mapStripeError } from "../lib/stripe-errors";
import { parseBody } from "../lib/validation";
import type { Workspace } from "../lib/workspace";

// Onboarding tokens are single-use links minted by an admin action; they
// should not remain valid indefinitely. This bounds the window (based on
// the token's `createdAt`) after which the recipient must request a fresh
// link via the resend flow.
const ONBOARDING_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const STRIPE_ONBOARDING_CIRCUIT_OPEN_ERROR = {
  error: "Stripe onboarding service is temporarily unavailable.",
  code: "STRIPE_CIRCUIT_OPEN",
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function hashRegenerationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

interface AccountLinkContext {
  accountLinkUrl: string;
}

type OnboardingTokenRecord = typeof onboardingTokens.$inferSelect;

const accountBodySchema = z.object({
  name: z.string({ error: "name is required." }).trim().min(1, "name is required."),
  email: z.string({ error: "email is required." }).email("email must be a valid email address."),
  groupId: z.string().optional(),
  workspace: z.literal("client_portal", { error: "workspace must be client_portal." }),
});

const initiateBodySchema = z.object({
  name: z.string({ error: "name is required." }).trim().min(1, "name is required."),
  email: z.string({ error: "email is required." }).email("email must be a valid email address."),
  groupId: z.string().optional(),
  workspace: z.literal("client_portal", { error: "workspace is required." }),
});

const resendBodySchema = z
  .object({
    email: z.email({ error: "email must be a valid email address." }).optional(),
    clientId: z.string().optional(),
    workspace: z.literal("client_portal", { error: "Invalid workspace." }).optional(),
  })
  .refine((body) => !!body.email || !!body.clientId, {
    message: "Either email or clientId is required.",
  });

const regenerateRequestSchema = z.object({
  email: z.string({ error: "email is required." }).email("email must be a valid email address."),
});

const regenerateRequestAdminSchema = z.object({
  clientId: z.string({ error: "clientId is required." }).min(1, "clientId is required."),
});

const tokenBodySchema = z.object({
  token: z.string({ error: "token is required." }).trim().min(1, "token is required."),
});

async function createAccountLinkForRecord(
  request: FastifyRequest,
  onboardingRecord: OnboardingTokenRecord
): Promise<AccountLinkContext> {
  if (onboardingRecord.status === "revoked") {
    throw errors.notFound("Onboarding link");
  }

  if (onboardingRecord.status !== "pending" && onboardingRecord.status !== "in_progress") {
    throw errors.notFound("Onboarding token");
  }

  const createdAt = onboardingRecord.createdAt ? new Date(onboardingRecord.createdAt) : null;
  if (createdAt && Date.now() - createdAt.getTime() > ONBOARDING_TOKEN_TTL_MS) {
    throw errors.notFound("Onboarding link expired");
  }

  const [clientRecord] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, onboardingRecord.clientId));

  if (!clientRecord) {
    throw errors.notFound("Client record");
  }

  let stripeAccountId = clientRecord.stripeAccountId;

  if (!stripeAccountId) {
    const account = await withStripeCircuit(() =>
      stripe.accounts.create(
        {
          type: "express",
          email: clientRecord.email,
          metadata: { clientId: clientRecord.id },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
        },
        { idempotencyKey: `acct-create-${clientRecord.id}` }
      )
    );

    // Conditional claim: only persist if no other concurrent request already
    // did so. `clients.stripeAccountId` is also uniquely indexed, so a
    // conflicting write would fail at the DB level regardless.
    const [claimed] = await db
      .update(clients)
      .set({ stripeAccountId: account.id })
      .where(and(eq(clients.id, clientRecord.id), isNull(clients.stripeAccountId)))
      .returning();

    if (claimed) {
      stripeAccountId = account.id;
    } else {
      // Another concurrent request already claimed a Stripe account for this
      // client. Re-read and use the existing id; the account we just created
      // is orphaned.
      // TODO: reconcile orphaned account via metadata.clientId
      const [refreshed] = await db.select().from(clients).where(eq(clients.id, clientRecord.id));
      stripeAccountId = refreshed?.stripeAccountId ?? account.id;
    }
  }

  const state = crypto.randomBytes(32).toString("hex");
  const stateExpiresAt = new Date(Date.now() + OAUTH_STATE_EXPIRY_MS);

  const baseUrl = resolveServerBaseUrl(request);
  const callbackUrl = `${baseUrl}/api/v1/connect/callback?client_id=${encodeURIComponent(clientRecord.id)}&state=${encodeURIComponent(state)}`;
  const refreshUrl = `${baseUrl}/api/v1/connect/refresh?client_id=${encodeURIComponent(clientRecord.id)}&state=${encodeURIComponent(state)}`;

  const accountLink = await withStripeCircuit(() =>
    stripe.accountLinks.create(
      {
        account: stripeAccountId,
        refresh_url: refreshUrl,
        return_url: callbackUrl,
        type: "account_onboarding",
      },
      { idempotencyKey: `acct-link-${clientRecord.id}-${state}` }
    )
  );

  request.log.info(
    {
      token_id: onboardingRecord.id,
      old_status: onboardingRecord.status,
      new_status: "in_progress",
      timestamp: new Date().toISOString(),
    },
    "Updating onboarding token status to in_progress"
  );

  await db
    .update(onboardingTokens)
    .set({
      status: "in_progress",
      state: state,
      stateExpiresAt: stateExpiresAt,
    })
    .where(eq(onboardingTokens.id, onboardingRecord.id));

  return { accountLinkUrl: accountLink.url };
}

async function createAccountLinkForToken(
  request: FastifyRequest,
  token: string
): Promise<AccountLinkContext> {
  const [onboardingRecord] = await db
    .select()
    .from(onboardingTokens)
    .where(eq(onboardingTokens.token, hashOnboardingToken(token)))
    .limit(1);

  if (!onboardingRecord) {
    throw errors.notFound("Onboarding token");
  }

  return createAccountLinkForRecord(request, onboardingRecord);
}

export default async function connectRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/accounts",
    {
      preHandler: [
        rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS }),
        requireAdminJwt,
      ],
      schema: {
        body: {
          type: "object",
          required: ["name", "email", "workspace"],
          properties: {
            name: { type: "string", minLength: 1 },
            email: { type: "string", format: "email" },
            groupId: { type: "string" },
            workspace: { type: "string", enum: ["client_portal"] },
          },
        },
      },
    },
    async (request, reply) => {
      const body = parseBody(accountBodySchema, request.body, reply) as
        | (z.infer<typeof accountBodySchema> & { workspace: Workspace })
        | null;
      if (!body) return;
      const { name, email, groupId, workspace } = body;

      request.log.info({ groupId, workspace }, "Received request in /accounts handler");

      if (groupId) {
        const [group] = await db
          .select({ id: clientGroups.id, workspace: clientGroups.workspace })
          .from(clientGroups)
          .where(eq(clientGroups.id, groupId))
          .limit(1);
        if (!group) {
          throw errors.badRequest("Invalid groupId.");
        }
        if (group.workspace !== workspace) {
          throw errors.badRequest("groupId workspace does not match workspace.");
        }
      }

      const { clientId, apiKey, token } = await createClientWithOnboardingToken({
        name,
        email,
        workspace,
        groupId,
      });

      const frontendOrigin = resolveFrontendOrigin();

      const onboardingUrlHint = `${frontendOrigin}/onboard#token=${encodeURIComponent(token)}`;

      request.log.info({ clientId, workspace, groupId }, "Client created via /accounts handler");

      return reply.code(201).send({
        name,
        // Note: this endpoint does not email the onboarding link (unlike
        // /onboard-client/initiate), so `onboardingUrlHint` remains the only
        // delivery mechanism for the admin caller. The raw token is no
        // longer duplicated in a separate `onboardingToken` field.
        onboardingUrlHint,
        apiKey,
        clientId,
        workspace,
        groupId: groupId ?? null,
      });
    }
  );

  fastify.post(
    "/onboard-client/initiate",
    {
      preHandler: [
        rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS }),
        requireAdminJwt,
      ],
      schema: {
        body: {
          type: "object",
          required: ["name", "email"],
          properties: {
            name: { type: "string", minLength: 1 },
            email: { type: "string", format: "email" },
            groupId: { type: "string" },
            workspace: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = parseBody(initiateBodySchema, request.body, reply);
      if (!body) return;
      const { name, email, groupId, workspace: workspaceParam } = body;

      if (groupId) {
        const [group] = await db
          .select({ id: clientGroups.id, workspace: clientGroups.workspace })
          .from(clientGroups)
          .where(eq(clientGroups.id, groupId))
          .limit(1);
        if (!group) {
          throw errors.badRequest("Invalid groupId.");
        }
        if (group.workspace !== workspaceParam) {
          throw errors.badRequest("groupId must belong to the specified workspace.");
        }
      }

      const settings = await getSettings();
      const companyName = settings.company_name || "DFW Software Consulting";

      // Both writes must land atomically: if the regeneration-token insert
      // fails after the client row is created, a bare retry would otherwise
      // hit "client already exists" with no delivered key ever having gone
      // out. Wrapping them in one transaction rolls back the client row too.
      const { clientId, token, rawRegenToken } = await db.transaction(async (tx) => {
        const created = await createClientWithOnboardingToken(
          {
            name,
            email,
            workspace: workspaceParam,
            groupId,
          },
          tx
        );

        const regenToken = await createRegenerationToken({ clientId: created.clientId, email }, tx);

        return { clientId: created.clientId, token: created.token, rawRegenToken: regenToken };
      });

      const frontendOrigin = resolveFrontendOrigin();

      const onboardingUrl = `${frontendOrigin}/onboard#token=${encodeURIComponent(token)}`;
      const regenerateUrl = `${frontendOrigin}/regenerate-key#token=${encodeURIComponent(rawRegenToken)}`;

      const safeName = he.encode(name);
      const mailHtml = `
        <h1>Welcome to ${he.encode(companyName)}</h1>
        <p>Hi ${safeName},</p>
        <p>Click the link below to start your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Onboard Now</a>
        <p>You will also need an API key to integrate with our services. Use the link below to retrieve it. This link expires in 15 minutes.</p>
        <a href="${regenerateUrl}">Retrieve Your API Key</a>
        <p>If you did not request this, please ignore this email.</p>
      `;

      const mailText = `
        Welcome to ${companyName}
        Hi ${name},
        Click the link below to start your Stripe onboarding process.
        ${onboardingUrl}
        You will also need an API key to integrate with our services. Use the link below to retrieve it. This link expires in 15 minutes.
        ${regenerateUrl}
        If you did not request this, please ignore this email.
      `;

      try {
        await sendMail({
          to: email,
          subject: `${companyName} - Stripe Onboarding`,
          html: mailHtml,
          text: mailText,
        });
      } catch (err) {
        request.log.error({ err, clientId }, "Failed to send onboarding email");
        try {
          await db.transaction(async (tx) => {
            const result = await tx
              .delete(clients)
              .where(
                and(
                  eq(clients.id, clientId),
                  eq(clients.email, email),
                  eq(clients.workspace, workspaceParam)
                )
              );

            if (result.rowCount !== 1) {
              throw new Error(`Expected to delete 1 client row, deleted ${result.rowCount ?? 0}`);
            }
          });
        } catch (cleanupErr) {
          request.log.error(
            { err: cleanupErr, clientId },
            "Failed to clean up client after email failure"
          );
          throw errors.emailFailed(
            "Failed to send onboarding email and clean up client. Please contact support."
          );
        }
        throw errors.emailFailed("Failed to send onboarding email. Please try again.");
      }

      return reply.code(201).send({
        message: "Onboarding email sent successfully.",
        clientId,
        apiKey: null,
        groupId: groupId ?? null,
      });
    }
  );

  fastify.post(
    "/onboard-client/resend",
    {
      preHandler: [
        rateLimit({ max: AUTH_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS }),
        requireAdminJwt,
      ],
      schema: {
        body: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            clientId: { type: "string" },
            workspace: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = parseBody(resendBodySchema, request.body, reply);
      if (!body) return;
      const { email, clientId, workspace: workspaceParam } = body;

      const [clientRecord] = clientId
        ? await db.select().from(clients).where(eq(clients.id, clientId))
        : email
          ? await db.select().from(clients).where(eq(clients.email, email))
          : [];

      if (!clientRecord) {
        throw errors.notFound("Client");
      }

      if (workspaceParam && clientRecord.workspace !== workspaceParam) {
        throw errors.badRequest("Client does not belong to the specified workspace.");
      }

      // Client is already fully onboarded (has a Stripe account and can
      // accept charges) — avoid re-issuing a new onboarding link/token.
      if (clientRecord.stripeAccountId && clientRecord.chargesEnabled) {
        return reply.code(200).send({
          message: "Onboarding is already complete for this client.",
          clientId: clientRecord.id,
          alreadyOnboarded: true,
        });
      }

      const { rowCount } = await db
        .update(onboardingTokens)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(
          and(
            eq(onboardingTokens.clientId, clientRecord.id),
            inArray(onboardingTokens.status, ["pending", "in_progress"])
          )
        );
      if (rowCount && rowCount > 0) {
        request.log.info(
          { client_id: clientRecord.id, revoked: rowCount },
          "Revoked active onboarding tokens"
        );
      }

      const newToken = crypto.randomBytes(32).toString("hex");
      const newTokenLookup = hashOnboardingToken(newToken);
      const newOnboardingTokenId = uuidv4();

      await db.insert(onboardingTokens).values({
        id: newOnboardingTokenId,
        clientId: clientRecord.id,
        token: newTokenLookup,
        status: "pending",
        email: clientRecord.email,
      });

      const settings = await getSettings();
      const companyName = settings.company_name || "DFW Software Consulting";

      const frontendOrigin = resolveFrontendOrigin();

      const onboardingUrl = `${frontendOrigin}/onboard#token=${encodeURIComponent(newToken)}`;

      const safeName = he.encode(clientRecord.name);
      const mailHtml = `
        <h1>Stripe Onboarding Link Refreshed</h1>
        <p>Hi ${safeName},</p>
        <p>Your previous onboarding link has expired or been invalidated.</p>
        <p>Click the new link below to continue with your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Continue Onboarding</a>
        <p>If you did not request this, please contact us.</p>
        <p><strong>Note:</strong> This link will expire in 24 hours.</p>
      `;

      const mailText = `
        Stripe Onboarding Link Refreshed
        Hi ${clientRecord.name},
        Your previous onboarding link has expired or been invalidated.
        Click the new link below to continue with your Stripe onboarding process.
        ${onboardingUrl}
        If you did not request this, please contact us.
        Note: This link will expire in 24 hours.
      `;

      try {
        await sendMail({
          to: clientRecord.email,
          subject: `${companyName} - New Onboarding Link`,
          html: mailHtml,
          text: mailText,
        });
      } catch (err) {
        request.log.error({ err, clientId: clientRecord.id }, "Failed to send onboarding email");
      }

      request.log.info(
        {
          client_id: clientRecord.id,
          client_email: clientRecord.email,
          new_token_id: newOnboardingTokenId,
        },
        "Onboarding token resent successfully"
      );

      return reply.code(200).send({
        message: "New onboarding link sent successfully.",
        clientId: clientRecord.id,
      });
    }
  );

  fastify.post(
    "/onboard-client",
    {
      preHandler: [rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS })],
    },
    async (request, reply) => {
      const body = parseBody(tokenBodySchema, request.body, reply);
      if (!body) return;
      const { token } = body;
      try {
        const { accountLinkUrl } = await createAccountLinkForToken(request, token);
        return reply.send({ url: accountLinkUrl });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        request.log.error(
          {
            error: errorMessage,
            token_hash: hashToken(token),
          },
          "Stripe accountLinks.create failed"
        );

        if (error instanceof AppError) {
          throw error;
        }

        if (mapStripeError(error, reply, { circuitOpen: STRIPE_ONBOARDING_CIRCUIT_OPEN_ERROR }))
          return;

        throw errors.stripeFailed("Failed to create Stripe account link. Please try again.");
      }
    }
  );

  fastify.get(
    "/connect/refresh",
    {
      preHandler: [rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS })],
    },
    async (request, reply) => {
      const { client_id, state } = request.query as { client_id?: string; state?: string };
      const normalizedClientId = typeof client_id === "string" ? client_id.trim() : "";
      const normalizedState = typeof state === "string" ? state.trim() : "";

      if (!normalizedClientId) {
        throw errors.badRequest("client_id is required.");
      }

      if (!normalizedState) {
        throw errors.badRequest("state is required.");
      }

      try {
        const [onboardingRecord] = await db
          .select()
          .from(onboardingTokens)
          .where(
            and(
              eq(onboardingTokens.clientId, normalizedClientId),
              eq(onboardingTokens.state, normalizedState)
            )
          )
          .limit(1);

        if (!onboardingRecord) {
          throw errors.notFound("Onboarding link");
        }

        if (
          onboardingRecord.stateExpiresAt &&
          new Date() > new Date(onboardingRecord.stateExpiresAt)
        ) {
          throw errors.notFound("Onboarding link expired");
        }

        const { accountLinkUrl } = await createAccountLinkForRecord(request, onboardingRecord);
        return reply.redirect(accountLinkUrl);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        request.log.error(
          {
            error: errorMessage,
            client_id: normalizedClientId,
            state_hash: hashToken(normalizedState),
          },
          "Stripe accountLinks.create failed during refresh"
        );

        if (error instanceof AppError) {
          throw error;
        }

        if (mapStripeError(error, reply, { circuitOpen: STRIPE_ONBOARDING_CIRCUIT_OPEN_ERROR }))
          return;

        throw errors.stripeFailed("Failed to create Stripe account link. Please try again.");
      }
    }
  );

  fastify.get(
    "/connect/callback",
    {
      preHandler: [rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS })],
    },
    async (request, reply) => {
      const { client_id, account, state } = request.query as {
        client_id?: string;
        account?: string;
        state?: string;
      };
      const normalizedClientId = (client_id ?? "").trim();
      const normalizedState = (state ?? "").trim();
      const normalizedAccount = (account ?? "").trim();

      if (!normalizedState) {
        request.log.warn({ client_id, account }, "Missing state parameter");
        throw errors.badRequest("Missing state parameter.");
      }

      if (!normalizedClientId) {
        request.log.warn({ account, state }, "Missing client_id parameter");
        throw errors.badRequest("Missing client_id parameter.");
      }

      // Stripe does NOT append `account` (or any state) to the Account Link
      // return_url, so it is optional. When present (legacy/manual links) we
      // validate its format and use it only as a defensive cross-check.
      if (normalizedAccount && !/^acct_[A-Za-z0-9]+$/.test(normalizedAccount)) {
        request.log.warn(
          { client_id: normalizedClientId, account: normalizedAccount },
          "Invalid account parameter format"
        );
        throw errors.badRequest("Invalid account parameter.");
      }

      // The (clientId, state) pair is the security binding: `state` is a
      // single-use CSRF nonce minted server-side at account-link creation.
      const [onboardingRecord] = await db
        .select()
        .from(onboardingTokens)
        .where(
          and(
            eq(onboardingTokens.clientId, normalizedClientId),
            eq(onboardingTokens.state, normalizedState)
          )
        )
        .limit(1);

      if (!onboardingRecord) {
        request.log.warn(
          { client_id: normalizedClientId, account: normalizedAccount, state: normalizedState },
          "Invalid or expired state parameter"
        );
        throw errors.badRequest("Invalid or expired state parameter.");
      }

      // `state` is meant to be single-use. Once a token has reached a
      // terminal status (completed/revoked) its state must be treated as
      // already consumed, even if it hasn't been nulled out yet — this
      // rejects replay of a previously-successful callback.
      if (onboardingRecord.status === "completed" || onboardingRecord.status === "revoked") {
        request.log.warn(
          {
            client_id: normalizedClientId,
            account: normalizedAccount,
            state: normalizedState,
            token_status: onboardingRecord.status,
          },
          "Replayed or already-consumed state parameter"
        );
        throw errors.badRequest("Invalid or expired state parameter.");
      }

      if (
        onboardingRecord.stateExpiresAt &&
        new Date() > new Date(onboardingRecord.stateExpiresAt)
      ) {
        request.log.warn(
          { client_id: normalizedClientId, account: normalizedAccount, state: normalizedState },
          "Expired state parameter"
        );
        throw errors.badRequest("Expired state parameter.");
      }

      const [clientRecord] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, normalizedClientId));

      if (!clientRecord) {
        request.log.warn(
          { client_id: normalizedClientId, account: normalizedAccount },
          "Client record not found during callback"
        );
        throw errors.badRequest("Client not found.");
      }

      const storedAccountId = clientRecord.stripeAccountId ?? null;

      // Defensive: refuse to swap an account if a different id was supplied than
      // the one already linked to this client.
      if (normalizedAccount && storedAccountId && storedAccountId !== normalizedAccount) {
        request.log.warn(
          {
            client_id: normalizedClientId,
            account: normalizedAccount,
            existingAccount: storedAccountId,
          },
          "Attempt to overwrite existing stripeAccountId"
        );
        throw errors.badRequest("Stripe account already linked to this client.");
      }

      const frontendOrigin = resolveFrontendOrigin();
      const redirectBase = `${frontendOrigin}/onboarding-success`;

      // The account id is persisted at account-link creation, so the stored
      // value is the source of truth; fall back to a supplied `account`.
      const effectiveAccountId = storedAccountId ?? (normalizedAccount || null);

      if (!effectiveAccountId) {
        request.log.warn(
          { client_id: normalizedClientId, state: normalizedState },
          "No Stripe account id resolved at callback; leaving token in_progress"
        );
        return reply.redirect(`${redirectBase}?status=pending`);
      }

      let verifiedAccount: Stripe.Account;
      try {
        verifiedAccount = await withStripeCircuit(() =>
          stripe.accounts.retrieve(effectiveAccountId)
        );
      } catch (err) {
        if (mapStripeError(err, reply, { circuitOpen: STRIPE_ONBOARDING_CIRCUIT_OPEN_ERROR })) {
          request.log.warn(
            { account: effectiveAccountId, err },
            "Stripe circuit open while verifying account; leaving token in_progress"
          );
          return;
        }
        // Transient Stripe failure on a user-facing return: don't dead-end the
        // user. The account.updated webhook reconciles readiness authoritatively.
        request.log.warn(
          { account: effectiveAccountId, err },
          "Failed to verify account with Stripe; leaving token in_progress"
        );
        return reply.redirect(`${redirectBase}?status=error`);
      }

      if (verifiedAccount.type !== "express") {
        request.log.warn({ account: effectiveAccountId }, "Account is not an Express account");
        throw errors.badRequest("Invalid account type.");
      }

      const chargesEnabled = verifiedAccount.charges_enabled ?? false;
      const payoutsEnabled = verifiedAccount.payouts_enabled ?? false;
      const detailsSubmitted = verifiedAccount.details_submitted ?? false;
      const tokenStatus = detailsSubmitted ? "completed" : "in_progress";

      request.log.info(
        {
          token_id: onboardingRecord.id,
          old_status: onboardingRecord.status,
          new_status: tokenStatus,
          chargesEnabled,
          payoutsEnabled,
          detailsSubmitted,
          timestamp: new Date().toISOString(),
        },
        "Syncing onboarding callback result"
      );

      await db.transaction(async (tx) => {
        await tx
          .update(clients)
          .set({
            stripeAccountId: effectiveAccountId,
            chargesEnabled,
            payoutsEnabled,
            detailsSubmitted,
            updatedAt: new Date(),
          })
          .where(eq(clients.id, normalizedClientId));
        await tx
          .update(onboardingTokens)
          .set({
            status: tokenStatus,
            // Single-use nonce: invalidate on first successful callback
            // regardless of in_progress/completed, so this callback URL
            // cannot be replayed. Legitimate re-entry (POST /onboard-client,
            // GET /connect/refresh) mints a fresh state via
            // createAccountLinkForToken.
            state: null,
            updatedAt: new Date(),
          })
          .where(eq(onboardingTokens.id, onboardingRecord.id));
      });

      return reply.redirect(
        `${redirectBase}?status=${tokenStatus === "completed" ? "completed" : "pending"}`
      );
    }
  );

  fastify.post(
    "/api-key/regenerate-request",
    {
      preHandler: [rateLimit({ max: AUTH_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS })],
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = parseBody(regenerateRequestSchema, request.body, reply);
      if (!body) return;
      const { email } = body;

      const [clientRecord] = await db
        .select()
        .from(clients)
        .where(and(eq(clients.email, email), eq(clients.status, "active")))
        .limit(1);

      if (clientRecord) {
        const rawToken = await createRegenerationToken({
          clientId: clientRecord.id,
          email: clientRecord.email,
        });

        const settings = await getSettings();
        const companyName = settings.company_name || "DFW Software Consulting";
        const frontendOrigin = resolveFrontendOrigin();
        const regenerateUrl = `${frontendOrigin}/regenerate-key#token=${encodeURIComponent(rawToken)}`;

        const safeName = he.encode(clientRecord.name);
        const mailHtml = `
          <h1>API Key Regeneration</h1>
          <p>Hi ${safeName},</p>
          <p>A request was made to regenerate your API key.</p>
          <p>Click the link below to generate a new key. This link will expire in 15 minutes.</p>
          <a href="${regenerateUrl}">Regenerate API Key</a>
          <p>If you did not request this, please ignore this email. Your current API key will remain valid.</p>
        `;

        const mailText = `
          API Key Regeneration
          Hi ${clientRecord.name},
          A request was made to regenerate your API key.
          Click the link below to generate a new key. This link will expire in 15 minutes.
          ${regenerateUrl}
          If you did not request this, please ignore this email. Your current API key will remain valid.
        `;

        try {
          await sendMail({
            to: clientRecord.email,
            subject: `${companyName} - Regenerate API Key`,
            html: mailHtml,
            text: mailText,
          });
        } catch (err) {
          request.log.error(
            { err, clientId: clientRecord.id },
            "Failed to send regeneration email"
          );
        }
      }

      return reply.code(200).send({
        message: "If an account with that email exists, a regeneration link has been sent.",
      });
    }
  );

  fastify.post(
    "/api-key/regenerate-request/admin",
    {
      preHandler: [
        rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS }),
        requireAdminJwt,
      ],
      schema: {
        body: {
          type: "object",
          required: ["clientId"],
          properties: {
            clientId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = parseBody(regenerateRequestAdminSchema, request.body, reply);
      if (!body) return;
      const { clientId } = body;

      const [clientRecord] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);

      if (!clientRecord) {
        throw errors.notFound("Client");
      }

      const rawToken = await createRegenerationToken({
        clientId: clientRecord.id,
        email: clientRecord.email,
      });

      const settings = await getSettings();
      const companyName = settings.company_name || "DFW Software Consulting";
      const frontendOrigin = resolveFrontendOrigin();
      const regenerateUrl = `${frontendOrigin}/regenerate-key#token=${encodeURIComponent(rawToken)}`;

      const safeName = he.encode(clientRecord.name);
      const mailHtml = `
        <h1>API Key Regeneration</h1>
        <p>Hi ${safeName},</p>
        <p>An administrator has initiated a regeneration of your API key.</p>
        <p>Click the link below to generate a new key. This link will expire in 15 minutes.</p>
        <a href="${regenerateUrl}">Regenerate API Key</a>
        <p>If you did not expect this, please contact your administrator.</p>
      `;

      const mailText = `
        API Key Regeneration
        Hi ${clientRecord.name},
        An administrator has initiated a regeneration of your API key.
        Click the link below to generate a new key. This link will expire in 15 minutes.
        ${regenerateUrl}
        If you did not expect this, please contact your administrator.
      `;

      try {
        await sendMail({
          to: clientRecord.email,
          subject: `${companyName} - Regenerate API Key`,
          html: mailHtml,
          text: mailText,
        });
      } catch (err) {
        request.log.error({ err, clientId: clientRecord.id }, "Failed to send regeneration email");
        try {
          const tokenHash = hashRegenerationToken(rawToken);
          const result = await db
            .update(apiKeyRegenerationTokens)
            .set({ status: "revoked", updatedAt: new Date() })
            .where(
              and(
                eq(apiKeyRegenerationTokens.clientId, clientRecord.id),
                eq(apiKeyRegenerationTokens.token, tokenHash),
                eq(apiKeyRegenerationTokens.status, "pending")
              )
            );

          if (result.rowCount !== 1) {
            throw new Error(
              `Expected to revoke 1 regeneration token, revoked ${result.rowCount ?? 0}`
            );
          }
        } catch (cleanupErr) {
          request.log.error(
            { err: cleanupErr, clientId: clientRecord.id },
            "Failed to revoke unsent regeneration token"
          );
          throw errors.emailFailed(
            "Failed to send regeneration email and revoke unsent token. Please contact support."
          );
        }
        throw errors.emailFailed("Failed to send regeneration email. Please try again.");
      }

      return reply.code(200).send({
        message: "Regeneration email sent successfully.",
        clientId: clientRecord.id,
      });
    }
  );

  fastify.post(
    "/api-key/regenerate",
    {
      preHandler: [rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS })],
    },
    async (request, reply) => {
      const body = parseBody(tokenBodySchema, request.body, reply);
      if (!body) return;
      const { token } = body;

      const newApiKey = await validateAndRegenerate(token);

      return reply.code(200).send({ apiKey: newApiKey });
    }
  );
}
