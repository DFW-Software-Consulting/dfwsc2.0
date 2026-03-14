import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { stripe } from '../lib/stripe';
import { db } from '../db/client';
import { clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireApiKey, requireAdminJwt } from '../lib/auth';
import { rateLimit } from '../lib/rate-limit';

function extractIdempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers['idempotency-key'];
  return Array.isArray(key) ? key[0] : key;
}

type RequestWithClient = FastifyRequest & { client?: typeof clients.$inferSelect };

function resolvePaymentRateLimitKey(request: RequestWithClient): string {
  const client = request.client;
  if (client?.stripeAccountId) {
    return `stripe:${client.stripeAccountId}`;
  }

  return request.ip || 'unknown';
}

function resolveClientFee(client: typeof clients.$inferSelect, amount?: number): number {
  if (client.processingFeePercent !== null && client.processingFeePercent !== undefined) {
    if (typeof amount !== 'number') {
      throw new Error('amount is required when client uses a percentage-based fee.');
    }
    return Math.round(amount * parseFloat(client.processingFeePercent) / 100);
  }
  if (client.processingFeeCents !== null && client.processingFeeCents !== undefined) {
    return client.processingFeeCents;
  }
  return Number(process.env.DEFAULT_PROCESS_FEE_CENTS ?? 0);
}

async function requireStripeAccountForPayments(request: RequestWithClient, reply: FastifyReply) {
  const client = request.client;
  if (!client) {
    return reply.code(401).send({ error: 'API key is required.' });
  }
  if (!client.stripeAccountId) {
    return reply.code(400).send({ error: 'Client does not have a connected Stripe account.' });
  }
}

export default async function paymentsRoutes(fastify: FastifyInstance) {
  // Compute useCheckout flag at route registration time
  const useCheckout = (process.env.USE_CHECKOUT ?? 'false').toLowerCase() === 'true';
  fastify.post(
    '/payments/create',
    {
      preHandler: [
        requireApiKey,
        requireStripeAccountForPayments,
        rateLimit({ max: 20, windowMs: 60_000, keyGenerator: resolvePaymentRateLimitKey }),
      ],
    },
    async (request, reply) => {
      const idempotencyKey = extractIdempotencyKey(request);
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
        return reply.code(400).send({ error: 'Idempotency-Key header is required.' });
      }

      const {
        amount,
        currency,
        description,
        metadata,
        lineItems,
      } = request.body as {
        amount?: number;
        currency?: string;
        description?: string;
        metadata?: Record<string, string>;
        lineItems?: Stripe.Checkout.SessionCreateParams.LineItem[];
      };

      const client = (request as RequestWithClient).client;
      if (!client) {
        return reply.code(500).send({ error: 'Unable to resolve client from API key.' });
      }

      const clientId = client.id;

      if (!client.stripeAccountId) {
        return reply.code(400).send({ error: 'Client does not have a connected Stripe account.' });
      }

      if (!useCheckout) {
        if (typeof amount !== 'number' || !currency) {
          return reply.code(400).send({ error: 'amount and currency are required for PaymentIntents.' });
        }

        let feeAmount: number;
        try {
          feeAmount = resolveClientFee(client, amount);
        } catch (e: unknown) {
          return reply.code(400).send({ error: (e as Error).message });
        }
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

      let feeAmount: number;
      try {
        feeAmount = resolveClientFee(client, amount);
      } catch (e: unknown) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      if (feeAmount < 0) {
        return reply.code(400).send({ error: 'applicationFeeAmount must be zero or positive.' });
      }

      if (typeof amount === 'number' && amount >= 0 && feeAmount > amount) {
        return reply
          .code(400)
          .send({ error: 'applicationFeeAmount cannot exceed the total amount.' });
      }

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(',')[0].trim().replace(/\/$/, '');
      if (!frontendOrigin) {
        return reply.code(500).send({ error: 'FRONTEND_ORIGIN is not configured.' });
      }

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: lineItems,
          success_url: client.paymentSuccessUrl
            ?? `${frontendOrigin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: client.paymentCancelUrl
            ?? `${frontendOrigin}/payment-cancel`,
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
