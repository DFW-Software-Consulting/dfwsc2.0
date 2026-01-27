import { FastifyInstance, FastifyRequest } from 'fastify';
import { stripe } from '../lib/stripe';
import { db } from '../db/client';
import { clients, onboardingTokens } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdminJwt, hashApiKey } from '../lib/auth';
import { rateLimit } from '../lib/rate-limit';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sendMail } from '../lib/mailer';
import validator from 'validator';
import he from 'he';

function resolveServerBaseUrl(request: FastifyRequest): string {
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL.replace(/\/$/, '');
  }

  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  const protocol = (request.headers['x-forwarded-proto'] as string) ?? request.protocol;

  if (!host || !protocol) {
    throw new Error('Unable to determine server base URL for onboarding.');
  }

  return `${protocol}://${host}`.replace(/\/$/, '');
}

function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

interface ClientWithToken {
  clientId: string;
  apiKey: string;
  token: string;
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

  if (!onboardingRecord || (onboardingRecord.status !== 'pending' && onboardingRecord.status !== 'in_progress')) {
    throw Object.assign(
      new Error('Onboarding token not found, is invalid, or has already been used.'),
      { statusCode: 404 }
    );
  }

  const [clientRecord] = await db.select().from(clients).where(eq(clients.id, onboardingRecord.clientId));

  if (!clientRecord) {
    throw Object.assign(new Error('Client record not found.'), { statusCode: 404 });
  }

  let stripeAccountId = clientRecord.stripeAccountId;

  if (!stripeAccountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: clientRecord.email,
      metadata: { clientId: clientRecord.id },
    });
    stripeAccountId = account.id;

    await db.update(clients).set({ stripeAccountId }).where(eq(clients.id, clientRecord.id));
  }

  // Generate a cryptographically secure state parameter
  const state = crypto.randomBytes(32).toString('hex');

  // Set expiration time to 30 minutes from now
  const stateExpiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes in milliseconds

  const baseUrl = resolveServerBaseUrl(request);
  const callbackUrl = `${baseUrl}/api/v1/connect/callback?client_id=${encodeURIComponent(clientRecord.id)}&state=${encodeURIComponent(state)}`;
  const refreshUrl = `${baseUrl}/api/v1/connect/refresh?token=${encodeURIComponent(token)}`;

  const accountLink = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: refreshUrl,
    return_url: callbackUrl,
    type: 'account_onboarding',
  });

  // Only update the onboarding token status to in_progress after successful Stripe API call
  request.log.info({
    token_id: onboardingRecord.id,
    old_status: onboardingRecord.status,
    new_status: 'in_progress',
    timestamp: new Date().toISOString()
  }, 'Updating onboarding token status to in_progress');

  await db
    .update(onboardingTokens)
    .set({
      status: 'in_progress',
      state: state,
      stateExpiresAt: stateExpiresAt
    })
    .where(eq(onboardingTokens.id, onboardingRecord.id));

  return { accountLinkUrl: accountLink.url };
}

async function createClientWithOnboardingToken(
  name: string,
  email: string
): Promise<ClientWithToken> {
  // Input validation
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw Object.assign(new Error('Name is required and must be a non-empty string'), { statusCode: 400 });
  }

  if (!email || typeof email !== 'string' || !validator.isEmail(email)) {
    throw Object.assign(new Error('Valid email is required'), { statusCode: 400 });
  }

  const clientId = uuidv4();
  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  await db.insert(clients).values({ id: clientId, name, email, apiKeyHash });

  const token = crypto.randomBytes(32).toString('hex');
  const onboardingTokenId = uuidv4();

  try {
    await db.insert(onboardingTokens).values({
      id: onboardingTokenId,
      clientId: clientId,
      token: token,
      status: 'pending',
      email: email,
    });
  } catch (error) {
    // If inserting the onboarding token fails, try to clean up the client record
    try {
      await db.delete(clients).where(eq(clients.id, clientId));
    } catch (cleanupError) {
      // If cleanup fails, log the error but don't throw to avoid masking the original error
      console.error(`Failed to clean up client record after onboarding token insertion failed: ${cleanupError}`);
    }
    throw error; // Re-throw the original error
  }

  return { clientId, apiKey, token };
}

export default async function connectRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/accounts',
    {

      preHandler: [rateLimit({ max: 10, windowMs: 60_000 }), requireAdminJwt],
    },
    async (request, reply) => {
      const { name, email } = request.body as { name: string; email: string };
      request.log.info({ name, email }, 'Received request in /accounts handler');

      const { clientId, apiKey, token } = await createClientWithOnboardingToken(name, email);

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.replace(/\/$/, '');
      if (!frontendOrigin) {
        return reply.code(500).send({ error: 'FRONTEND_ORIGIN is not configured.' });
      }

      const onboardingUrlHint = `${frontendOrigin}/onboard?token=${token}`;

      return reply.code(201).send({
        name,
        onboardingToken: token,
        onboardingUrlHint,
        apiKey,
        clientId,
      });
    },
  );

  fastify.post(
    '/onboard-client/initiate',
    {

      preHandler: [rateLimit({ max: 10, windowMs: 60_000 }), requireAdminJwt],
    },
    async (request, reply) => {
      const { name, email } = request.body as { name: string; email: string };

      const { clientId, apiKey, token } = await createClientWithOnboardingToken(name, email);

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.replace(/\/$/, '');
      if (!frontendOrigin) {
        return reply.code(500).send({ error: 'FRONTEND_ORIGIN is not configured.' });
      }

      const onboardingUrl = `${frontendOrigin}/onboard?token=${token}`;

      const safeName = he.encode(name);
      const mailHtml = `
        <h1>Welcome to DFW Software Consulting</h1>
        <p>Hi ${safeName},</p>
        <p>Click the link below to start your Stripe onboarding process.</p>
        <a href="${onboardingUrl}">Onboard Now</a>
        <p>If you did not request this, please ignore this email.</p>
      `;

      const mailText = `
        Welcome to DFW Software Consulting
        Hi ${name},
        Click the link below to start your Stripe onboarding process.
        ${onboardingUrl}
        If you did not request this, please ignore this email.
      `;

      await sendMail({
        to: email,
        subject: 'DFW Software Consulting - Stripe Onboarding',
        html: mailHtml,
        text: mailText,
      });

      return reply.code(201).send({
        message: 'Onboarding email sent successfully.',
        clientId,
        apiKey,
      });
    },
  );

  fastify.get(
    '/onboard-client',
    {

    },
    async (request, reply) => {
      const { token } = request.query as { token: string };
      try {
        const { accountLinkUrl } = await createAccountLinkForToken(request, token);
        return reply.send({ url: accountLinkUrl });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
          ? error.statusCode
          : 502;
        request.log.error({
          error: errorMessage,
          token
        }, 'Stripe accountLinks.create failed');

        if (statusCode === 404) {
          return reply.code(404).send({ error: errorMessage });
        }

        // Return 502 Bad Gateway error, token remains in pending or in_progress status for retry
        return reply.code(502).send({
          error: 'Failed to create Stripe account link. Please try again.',
          code: 'STRIPE_ACCOUNT_LINK_FAILED'
        });
      }
    },
  );

  fastify.get(
    '/connect/refresh',
    {

    },
    async (request, reply) => {
      const { token } = request.query as { token: string };

      try {
        const { accountLinkUrl } = await createAccountLinkForToken(request, token);
        return reply.redirect(accountLinkUrl);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
          ? error.statusCode
          : 502;
        request.log.error({
          error: errorMessage,
          token
        }, 'Stripe accountLinks.create failed during refresh');

        return reply.code(statusCode).send({ error: errorMessage });
      }
    },
  );

  fastify.get(
    '/connect/callback',
    {

    },
    async (request, reply) => {
      const { client_id, account, state } = request.query as {
        client_id: string;
        account?: string;
        state?: string;
      };

      // Check if state parameter is missing - return 400 error if missing
      if (!state) {
        request.log.warn({ client_id, account }, 'Missing state parameter');
        return reply.code(400).send({ error: 'Missing state parameter.' });
      }

      if (!account) {
        request.log.warn({ client_id, state }, 'Missing account parameter');
        return reply.code(400).send({ error: 'Missing account parameter.' });
      }

      // Retrieve the onboarding token record by both client_id and state to ensure validity
      const [onboardingRecord] = await db
        .select()
        .from(onboardingTokens)
        .where(and(
          eq(onboardingTokens.clientId, client_id),
          eq(onboardingTokens.state, state)
        ))
        .limit(1);

      if (!onboardingRecord) {
        request.log.warn({ client_id, account, state }, 'Invalid or expired state parameter');
        return reply.code(400).send({ error: 'Invalid or expired state parameter.' });
      }

      // Check if state has expired
      if (onboardingRecord.stateExpiresAt && new Date() > new Date(onboardingRecord.stateExpiresAt)) {
        request.log.warn({ client_id, account, state }, 'Expired state parameter');
        return reply.code(400).send({ error: 'Expired state parameter.' });
      }

      // Verify that the account parameter matches what we expect for the client
      // This prevents an attacker from providing a different account ID
      const [clientRecord] = await db.select().from(clients).where(eq(clients.id, client_id));
      if (!clientRecord) {
        request.log.warn({ client_id, account }, 'Client record not found');
        const frontendOrigin = process.env.FRONTEND_ORIGIN?.replace(/\/$/, '');
        if (!frontendOrigin) {
          request.log.error('FRONTEND_ORIGIN is not configured');
          return reply.code(500).send({ error: 'Server configuration error: FRONTEND_ORIGIN not set.' });
        }
        // Still redirect to success page even if client record is not found
        const redirectUrl = `${frontendOrigin}/onboarding-success`;
        return reply.redirect(redirectUrl);
      }

      const existingStripeAccountId =
        clientRecord.stripeAccountId ?? (clientRecord as { stripe_account_id?: string }).stripe_account_id ?? null;

      // If the client already has a stripeAccountId, verify it matches the one being set
      if (existingStripeAccountId && existingStripeAccountId !== account) {
        request.log.warn({
          client_id,
          account,
          existingAccount: existingStripeAccountId
        }, 'Attempt to overwrite existing stripeAccountId');
        return reply.code(400).send({ error: 'Stripe account already linked to this client.' });
      }

      // Update the client's stripeAccountId
      await db.update(clients).set({ stripeAccountId: account }).where(eq(clients.id, client_id));

      // Update the onboarding token status to completed
      request.log.info({
        token_id: onboardingRecord.id,
        old_status: onboardingRecord.status,
        new_status: 'completed',
        timestamp: new Date().toISOString()
      }, 'Updating onboarding token status to completed');

      await db
        .update(onboardingTokens)
        .set({ status: 'completed' })
        .where(eq(onboardingTokens.id, onboardingRecord.id));

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.replace(/\/$/, '');
      if (!frontendOrigin) {
        request.log.error('FRONTEND_ORIGIN is not configured');
        return reply.code(500).send({ error: 'Server configuration error: FRONTEND_ORIGIN not set.' });
      }
      const redirectUrl = `${frontendOrigin}/onboarding-success`;

      reply.redirect(redirectUrl);
    },
  );
}
