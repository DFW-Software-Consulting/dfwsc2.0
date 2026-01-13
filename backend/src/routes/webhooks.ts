import { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { stripe } from '../lib/stripe';
import { db } from '../db/client';
import { webhookEvents, clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!webhookSecret) {
  throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required.');
}
const resolvedWebhookSecret = webhookSecret;

export default async function webhooksRoute(fastify: FastifyInstance) {
  fastify.post('/webhooks/stripe', { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      return reply.code(400).send({ error: 'Missing Stripe-Signature header.' });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(request.rawBody as string, signature, resolvedWebhookSecret);
    } catch (err: any) {
      fastify.log.error({ err }, 'Failed to verify Stripe webhook signature.');
      return reply.code(400).send({ error: `Webhook Error: ${err.message}` });
    }

    await db
      .insert(webhookEvents)
      .values({
        id: uuidv4(),
        stripeEventId: event.id,
        type: event.type,
        payload: JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: webhookEvents.stripeEventId });

    switch (event.type) {
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        if (account.details_submitted) {
          fastify.log.info({ accountId: account.id }, 'Account details submitted, updating client record.');
          await db
            .update(clients)
            .set({
              name: account.settings?.dashboard.display_name ?? undefined,
              email: account.email ?? undefined,
              updatedAt: new Date(),
            })
            .where(eq(clients.stripeAccountId, account.id));
        }
        break;
      }
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        fastify.log.info({ intentId: intent.id, status: intent.status }, 'PaymentIntent event received.');
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        fastify.log.info({ chargeId: charge.id, amountRefunded: charge.amount_refunded }, 'Charge refunded.');
        break;
      }
      case 'payout.paid':
      case 'payout.failed': {
        const payout = event.data.object as Stripe.Payout;
        fastify.log.info({ payoutId: payout.id, status: payout.status }, 'Payout event received.');
        break;
      }
      default: {
        fastify.log.debug({ eventType: event.type }, 'Unhandled Stripe event type.');
      }
    }

    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.stripeEventId, event.id));

    return reply.send({ received: true });
  });
}
