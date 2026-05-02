import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import he from "he";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { clientGroups, clients, onboardingTokens } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { createClientWithOnboardingToken } from "../lib/client-factory";
import { sendMail } from "../lib/mailer";
import { rateLimit } from "../lib/rate-limit";
import { getSettings, stripe } from "../lib/stripe-billing";
import { isWorkspace, type Workspace } from "../lib/workspace";

function resolveServerBaseUrl(request: FastifyRequest): string {
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL.replace(/\/$/, "");
  }

  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  const protocol = (request.headers["x-forwarded-proto"] as string) ?? request.protocol;

  if (!host || !protocol) {
    throw new Error("Unable to determine server base URL for onboarding.");
  }

  return `${protocol}://${host}`.replace(/\/$/, "");
}

interface AccountLinkContext {
  accountLinkUrl: string;
}

async function createAccountLinkForToken(
  request: FastifyRequest,
  token: string
): Promise<AccountLinkContext> {
  const [onboardingRecord] = await db
    .select()
    .from(onboardingTokens)
    .where(eq(onboardingTokens.token, token))
    .limit(1);

  if (!onboardingRecord) {
    throw Object.assign(
      new Error("Onboarding token not found, is invalid, or has already been used."),
      { statusCode: 404 }
    );
  }

  if (onboardingRecord.status === "revoked") {
    throw Object.assign(
      new Error("This onboarding link has been replaced. Please check your email for a new link."),
      { statusCode: 404 }
    );
  }

  if (onboardingRecord.status !== "pending" && onboardingRecord.status !== "in_progress") {
    throw Object.assign(
      new Error("Onboarding token not found, is invalid, or has already been used."),
      { statusCode: 404 }
    );
  }

  const [clientRecord] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, onboardingRecord.clientId));

  if (!clientRecord) {
    throw Object.assign(new Error("Client record not found."), { statusCode: 404 });
  }

  let stripeAccountId = clientRecord.stripeAccountId;

  if (!stripeAccountId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: clientRecord.email,
      metadata: { clientId: clientRecord.id },
    });
    stripeAccountId = account.id;

    await db.update(clients).set({ stripeAccountId }).where(eq(clients.id, clientRecord.id));
  }

  const state = crypto.randomBytes(32).toString("hex");
  const stateExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

  const baseUrl = resolveServerBaseUrl(request);
  const callbackUrl = `${baseUrl}/api/v1/connect/callback?client_id=${encodeURIComponent(clientRecord.id)}&state=${encodeURIComponent(state)}`;
  const refreshUrl = `${baseUrl}/api/v1/connect/refresh?token=${encodeURIComponent(token)}`;

  const accountLink = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: refreshUrl,
    return_url: callbackUrl,
    type: "account_onboarding",
  });

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

export default async function connectRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/accounts",
    {
      preHandler: [rateLimit({ max: 10, windowMs: 60_000 }), requireAdminJwt],
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
      const { name, email, groupId, workspace } = request.body as {
        name: string;
        email: string;
        groupId?: string;
        workspace: Workspace;
      };
      if (!isWorkspace(workspace)) {
        return reply.code(400).send({ error: "workspace must be client_portal." });
      }

      request.log.info(
        { name, email, groupId, workspace },
        "Received request in /accounts handler"
      );

      if (groupId) {
        const [group] = await db
          .select({ id: clientGroups.id, workspace: clientGroups.workspace })
          .from(clientGroups)
          .where(eq(clientGroups.id, groupId))
          .limit(1);
        if (!group) {
          return reply.code(400).send({ error: "Invalid groupId." });
        }
        if (group.workspace !== workspace) {
          return reply.code(400).send({ error: "groupId workspace does not match workspace." });
        }
      }

      const { clientId, apiKey, token } = await createClientWithOnboardingToken({
        name,
        email,
        workspace,
        groupId,
      });

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
      if (!frontendOrigin) {
        return reply.code(500).send({ error: "FRONTEND_ORIGIN is not configured." });
      }

      const onboardingUrlHint = `${frontendOrigin}/onboard?token=${token}`;

      return reply.code(201).send({
        name,
        onboardingToken: token,
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
      preHandler: [rateLimit({ max: 10, windowMs: 60_000 }), requireAdminJwt],
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
      const {
        name,
        email,
        groupId,
        workspace: workspaceParam,
      } = request.body as {
        name: string;
        email: string;
        groupId?: string;
        workspace?: string;
      };

      if (!isWorkspace(workspaceParam)) {
        return reply.code(400).send({ error: "workspace is required." });
      }

      if (groupId) {
        const [group] = await db
          .select({ id: clientGroups.id, workspace: clientGroups.workspace })
          .from(clientGroups)
          .where(eq(clientGroups.id, groupId))
          .limit(1);
        if (!group) {
          return reply.code(400).send({ error: "Invalid groupId." });
        }
        if (group.workspace !== workspaceParam) {
          return reply.code(400).send({ error: "groupId must belong to the specified workspace." });
        }
      }

      const settings = await getSettings();
      const companyName = settings.company_name || "DFW Software Consulting";

      const { clientId, apiKey, token } = await createClientWithOnboardingToken({
        name,
        email,
        workspace: workspaceParam,
        groupId,
      });

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
      if (!frontendOrigin) {
        return reply.code(500).send({ error: "FRONTEND_ORIGIN is not configured." });
      }

      const onboardingUrl = `${frontendOrigin}/onboard?token=${token}`;

      const safeName = he.encode(name);
      const mailHtml = `
        <h1>Welcome to ${he.encode(companyName)}</h1>
        <p>Hi ${safeName},</p>
        <p>Click the link below to start your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Onboard Now</a>
        <p>If you did not request this, please ignore this email.</p>
      `;

      const mailText = `
        Welcome to ${companyName}
        Hi ${name},
        Click the link below to start your Stripe onboarding process.
        ${onboardingUrl}
        If you did not request this, please ignore this email.
      `;

      await sendMail({
        to: email,
        subject: `${companyName} - Stripe Onboarding`,
        html: mailHtml,
        text: mailText,
      });

      return reply.code(201).send({
        message: "Onboarding email sent successfully.",
        clientId,
        apiKey,
        groupId: groupId ?? null,
      });
    }
  );

  fastify.post(
    "/onboard-client/resend",
    {
      preHandler: [rateLimit({ max: 5, windowMs: 60_000 }), requireAdminJwt],
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
      const {
        email,
        clientId,
        workspace: workspaceParam,
      } = request.body as {
        email?: string;
        clientId?: string;
        workspace?: string;
      };

      if (!email && !clientId) {
        return reply.code(400).send({ error: "Either email or clientId is required." });
      }

      if (workspaceParam && !isWorkspace(workspaceParam)) {
        return reply.code(400).send({ error: "Invalid workspace." });
      }

      const [clientRecord] = clientId
        ? await db.select().from(clients).where(eq(clients.id, clientId))
        : email
          ? await db.select().from(clients).where(eq(clients.email, email))
          : [];

      if (!clientRecord) {
        return reply.code(404).send({ error: "Client not found." });
      }

      if (workspaceParam && clientRecord.workspace !== workspaceParam) {
        return reply
          .code(400)
          .send({ error: "Client does not belong to the specified workspace." });
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
      const newOnboardingTokenId = uuidv4();

      await db.insert(onboardingTokens).values({
        id: newOnboardingTokenId,
        clientId: clientRecord.id,
        token: newToken,
        status: "pending",
        email: clientRecord.email,
      });

      const settings = await getSettings();
      const companyName = settings.company_name || "DFW Software Consulting";

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
      if (!frontendOrigin) {
        return reply.code(500).send({ error: "FRONTEND_ORIGIN is not configured." });
      }

      const onboardingUrl = `${frontendOrigin}/onboard?token=${newToken}`;

      const safeName = he.encode(clientRecord.name);
      const mailHtml = `
        <h1>Stripe Onboarding Link Refreshed</h1>
        <p>Hi ${safeName},</p>
        <p>Your previous onboarding link has expired or been invalidated.</p>
        <p>Click the new link below to continue with your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Continue Onboarding</a>
        <p>If you did not request this, please contact us.</p>
        <p><strong>Note:</strong> This link will expire in 30 minutes.</p>
      `;

      const mailText = `
        Stripe Onboarding Link Refreshed
        Hi ${clientRecord.name},
        Your previous onboarding link has expired or been invalidated.
        Click the new link below to continue with your Stripe onboarding process.
        ${onboardingUrl}
        If you did not request this, please contact us.
        Note: This link will expire in 30 minutes.
      `;

      await sendMail({
        to: clientRecord.email,
        subject: `${companyName} - New Onboarding Link`,
        html: mailHtml,
        text: mailText,
      });

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

  fastify.get(
    "/onboard-client",
    {
      preHandler: [rateLimit({ max: 10, windowMs: 60_000 })],
    },
    async (request, reply) => {
      const { token } = request.query as { token: string };
      try {
        const { accountLinkUrl } = await createAccountLinkForToken(request, token);
        return reply.send({ url: accountLinkUrl });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const statusCode =
          error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : 502;
        request.log.error(
          {
            error: errorMessage,
            token,
          },
          "Stripe accountLinks.create failed"
        );

        if (statusCode === 404) {
          return reply.code(404).send({ error: errorMessage });
        }

        return reply.code(502).send({
          error: "Failed to create Stripe account link. Please try again.",
          code: "STRIPE_ACCOUNT_LINK_FAILED",
        });
      }
    }
  );

  fastify.get(
    "/connect/refresh",
    {
      preHandler: [rateLimit({ max: 10, windowMs: 60_000 })],
    },
    async (request, reply) => {
      const { token } = request.query as { token: string };

      try {
        const { accountLinkUrl } = await createAccountLinkForToken(request, token);
        return reply.redirect(accountLinkUrl);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const statusCode =
          error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : 502;
        request.log.error(
          {
            error: errorMessage,
            token,
          },
          "Stripe accountLinks.create failed during refresh"
        );

        return reply.code(statusCode).send({ error: errorMessage });
      }
    }
  );

  fastify.get("/connect/callback", {}, async (request, reply) => {
    const { client_id, account, state } = request.query as {
      client_id: string;
      account?: string;
      state?: string;
    };
    const normalizedClientId = (client_id ?? "").trim();
    const normalizedState = (state ?? "").trim();

    if (!normalizedState) {
      request.log.warn({ client_id, account }, "Missing state parameter");
      return reply.code(400).send({ error: "Missing state parameter." });
    }

    if (!account) {
      request.log.warn({ client_id, state }, "Missing account parameter");
      return reply.code(400).send({ error: "Missing account parameter." });
    }
    const normalizedAccount = account.trim();
    if (!normalizedAccount) {
      request.log.warn({ client_id, state }, "Missing account parameter");
      return reply.code(400).send({ error: "Missing account parameter." });
    }
    if (!normalizedClientId) {
      request.log.warn({ account, state }, "Missing client_id parameter");
      return reply.code(400).send({ error: "Missing client_id parameter." });
    }
    if (!/^acct_[A-Za-z0-9]+$/.test(normalizedAccount)) {
      request.log.warn(
        { client_id: normalizedClientId, account: normalizedAccount },
        "Invalid account parameter format"
      );
      return reply.code(400).send({ error: "Invalid account parameter." });
    }

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
        {
          client_id: normalizedClientId,
          account: normalizedAccount,
          state: normalizedState,
        },
        "Invalid or expired state parameter"
      );
      return reply.code(400).send({ error: "Invalid or expired state parameter." });
    }

    if (onboardingRecord.stateExpiresAt && new Date() > new Date(onboardingRecord.stateExpiresAt)) {
      request.log.warn(
        {
          client_id: normalizedClientId,
          account: normalizedAccount,
          state: normalizedState,
        },
        "Expired state parameter"
      );
      return reply.code(400).send({ error: "Expired state parameter." });
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
      return reply.code(400).send({ error: "Client not found." });
    }

    const existingStripeAccountId =
      clientRecord.stripeAccountId ??
      (clientRecord as { stripe_account_id?: string }).stripe_account_id ??
      null;

    if (existingStripeAccountId && existingStripeAccountId !== normalizedAccount) {
      request.log.warn(
        {
          client_id: normalizedClientId,
          account: normalizedAccount,
          existingAccount: existingStripeAccountId,
        },
        "Attempt to overwrite existing stripeAccountId"
      );
      return reply.code(400).send({ error: "Stripe account already linked to this client." });
    }

    request.log.info(
      {
        token_id: onboardingRecord.id,
        old_status: onboardingRecord.status,
        new_status: "completed",
        timestamp: new Date().toISOString(),
      },
      "Updating onboarding token status to completed"
    );

    await db.transaction(async (tx) => {
      await tx
        .update(clients)
        .set({ stripeAccountId: normalizedAccount })
        .where(eq(clients.id, normalizedClientId));
      await tx
        .update(onboardingTokens)
        .set({ status: "completed" })
        .where(eq(onboardingTokens.id, onboardingRecord.id));
    });

    const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
    if (!frontendOrigin) {
      request.log.error("FRONTEND_ORIGIN is not configured");
      return reply
        .code(500)
        .send({ error: "Server configuration error: FRONTEND_ORIGIN not set." });
    }
    const redirectUrl = `${frontendOrigin}/onboarding-success`;

    reply.redirect(redirectUrl);
  });
}
