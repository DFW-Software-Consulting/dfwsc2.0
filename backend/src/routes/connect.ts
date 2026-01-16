import { FastifyInstance, FastifyRequest } from 'fastify';
import { stripe } from '../lib/stripe';
import { db } from '../db/client';
import { clients, onboardingTokens } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdminJwt } from '../lib/auth';
import { rateLimit } from '../lib/rate-limit';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sendMail } from '../lib/mailer';

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

export default async function connectRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/accounts',
    {

      preHandler: [rateLimit({ max: 10, windowMs: 60_000 }), requireAdminJwt],
    },
    async (request, reply) => {
      request.log.info({ body: request.body, headers: request.headers }, 'Received request in /accounts handler');
      const { name, email } = request.body as { name: string; email: string };
      const clientId = uuidv4();
      const apiKey = generateApiKey();

      await db.insert(clients).values({ id: clientId, name, email, apiKey });

      const token = crypto.randomBytes(32).toString('hex');
      const onboardingTokenId = uuidv4();

      await db.insert(onboardingTokens).values({
        id: onboardingTokenId,
        clientId: clientId,
        token: token,
        status: 'pending',
        email: email,
      });

      const onboardingUrlHint = `https://dfwsc.com/onboard?token=${token}`;

      return reply.code(201).send({
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
      const clientId = uuidv4();
      const apiKey = generateApiKey();

      await db.insert(clients).values({ id: clientId, name, email, apiKey });

      const token = crypto.randomBytes(32).toString('hex');
      const onboardingTokenId = uuidv4();

      await db.insert(onboardingTokens).values({
        id: onboardingTokenId,
        clientId: clientId,
        token: token,
        status: 'pending',
        email: email,
      });

      const onboardingUrl = `https://dfwsc.com/onboard?token=${token}`;

      const mailHtml = `
        <h1>Welcome to DFW Software Consulting</h1>
        <p>Hi ${name},</p>
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

      const [onboardingRecord] = await db
        .select()
        .from(onboardingTokens)
        .where(and(eq(onboardingTokens.token, token), eq(onboardingTokens.status, 'pending')))
        .limit(1);

      if (!onboardingRecord) {
        return reply.code(404).send({ error: 'Onboarding token not found, is invalid, or has already been used.' });
      }

      const [clientRecord] = await db.select().from(clients).where(eq(clients.id, onboardingRecord.clientId));

      if (!clientRecord) {
        return reply.code(404).send({ error: 'Client record not found.' });
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

      // Update the onboarding token record with the state and expiration
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

      const baseUrl = resolveServerBaseUrl(request);
      const callbackUrl = `${baseUrl}/api/v1/connect/callback?client_id=${encodeURIComponent(clientRecord.id)}&state=${encodeURIComponent(state)}`;
      const refreshUrl = `${callbackUrl}&refresh=true`;

      const accountLink = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: refreshUrl,
        return_url: callbackUrl,
        type: 'account_onboarding',
      });

      return reply.send({ url: accountLink.url });
    },
  );

  fastify.get(
    '/connect/callback',
    {

    },
    async (request, reply) => {
      const { client_id, account, state } = request.query as { client_id: string; account: string; state: string };

      // Validate presence of state parameter
      if (!state) {
        request.log.warn({ client_id, account }, 'Missing state parameter in callback');
        return reply.code(400).send({ error: 'Missing state parameter.' });
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
        return reply.code(400).send({ error: 'Invalid client ID.' });
      }

      // If the client already has a stripeAccountId, verify it matches the one being set
      if (clientRecord.stripeAccountId && clientRecord.stripeAccountId !== account) {
        request.log.warn({
          client_id,
          account,
          existingAccount: clientRecord.stripeAccountId
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

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.replace(/\/$/, '') || 'https://dfwsc.com';
      const redirectUrl = `${frontendOrigin}/onboarding-success`;

      reply.redirect(redirectUrl);
    },
  );
}
