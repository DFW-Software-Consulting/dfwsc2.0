import { FastifyInstance, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { stripe } from '../lib/stripe';
import { db } from '../db/client';
import { clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireRole, requireAdminJwt } from '../lib/auth';
import { rateLimit } from '../lib/rate-limit';

const useCheckout = (process.env.USE_CHECKOUT ?? 'false').toLowerCase() === 'true';

function extractIdempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers['idempotency-key'];
  return Array.isArray(key) ? key[0] : key;
}

export default async function paymentsRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/payments/create',
    {
      preHandler: [rateLimit({ max: 20, windowMs: 60_000 }), requireRole(['admin', 'client'])],
    },
    async (request, reply) => {
      const idempotencyKey = extractIdempotencyKey(request);
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
        return reply.code(400).send({ error: 'Idempotency-Key header is required.' });
      }

      const {
        clientId,
        amount,
        currency,
        description,
        metadata,
        applicationFeeAmount,
        lineItems,
      } = request.body as {
        clientId?: string;
        amount?: number;
        currency?: string;
        description?: string;
        metadata?: Record<string, string>;
        applicationFeeAmount?: number;
        lineItems?: Stripe.Checkout.SessionCreateParams.LineItem[];
      };

      if (!clientId) {
        return reply.code(400).send({ error: 'clientId is required.' });
      }

      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      if (!client) {
        return reply.code(404).send({ error: 'Client not found.' });
      }

      if (!client.stripeAccountId) {
        return reply.code(400).send({ error: 'Client does not have a connected Stripe account.' });
      }

      if (!useCheckout) {
        if (typeof amount !== 'number' || !currency) {
          return reply.code(400).send({ error: 'amount and currency are required for PaymentIntents.' });
        }

const feeAmount = Number(process.env.DEFAULT_PROCESS_FEE_CENTS ?? 0);
        if (feeAmount < 0 || feeAmount > amount) {
          return reply
            .code(400)
            .send({ error: 'applicationFeeAmount must be between 0 and the payment amount.' });
        }

        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount,
            currency,
            automatic_payment_methods: { enabled: true },
            application_fee_amount: feeAmount,
            description,
            metadata: {
              ...(metadata ?? {}),
              clientId,
            },
          },
          { stripeAccount: client.stripeAccountId, idempotencyKey },
        );

        return reply.code(201).send({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
        });
      }

      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        return reply.code(400).send({ error: 'lineItems are required when USE_CHECKOUT=true.' });
      }

      const feeAmount = Number(process.env.DEFAULT_PROCESS_FEE_CENTS ?? 0);
      if (feeAmount < 0) {
        return reply.code(400).send({ error: 'applicationFeeAmount must be zero or positive.' });
      }

      if (typeof amount === 'number' && amount >= 0 && feeAmount > amount) {
        return reply
          .code(400)
          .send({ error: 'applicationFeeAmount cannot exceed the total amount.' });
      }

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.replace(/\/$/, '');
      if (!frontendOrigin) {
        return reply.code(500).send({ error: 'FRONTEND_ORIGIN is not configured.' });
      }

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: lineItems,
          success_url: `${frontendOrigin}/payments/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${frontendOrigin}/payments/cancel`,
          payment_intent_data: {
            application_fee_amount: feeAmount,
            description,
            metadata: {
              ...(metadata ?? {}),
              clientId,
            },
          },
          metadata: {
            clientId,
          },
        },
        { stripeAccount: client.stripeAccountId, idempotencyKey },
      );

      return reply.code(201).send({ url: session.url });
    },
  );

  fastify.get(
    '/reports/payments',
    { preHandler: requireAdminJwt },
    async (request, reply) => {
      const { clientId, limit, starting_after, ending_before } = request.query as {
        clientId?: string;
        limit?: string;
        starting_after?: string;
        ending_before?: string;
      };

      if (!clientId) {
        return reply.code(400).send({ error: 'clientId query parameter is required.' });
      }

      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      if (!client || !client.stripeAccountId) {
        return reply.code(404).send({ error: 'Client with connected account not found.' });
      }

      const listParams: Stripe.PaymentIntentListParams = {};
      if (limit) {
        const parsed = Number(limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
          return reply.code(400).send({ error: 'limit must be an integer between 1 and 100.' });
        }
        listParams.limit = parsed;
      }

      if (starting_after) {
        listParams.starting_after = starting_after;
      }

      if (ending_before) {
        listParams.ending_before = ending_before;
      }

      const paymentIntents = await stripe.paymentIntents.list(listParams, {
        stripeAccount: client.stripeAccountId,
      });

      return reply.send({
        clientId,
        data: paymentIntents.data,
        hasMore: paymentIntents.has_more,
      });
    },
  );
}
