import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { clients, webhookEvents } from "../db/schema";
import { stripe } from "../lib/stripe";

export default async function webhooksRoute(fastify: FastifyInstance) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET environment variable is required.");
  }
  const resolvedWebhookSecret = webhookSecret;
  fastify.post("/webhooks/stripe", { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string") {
      return reply.code(400).send({ error: "Missing Stripe-Signature header." });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.rawBody as string,
        signature,
        resolvedWebhookSecret
      );
    } catch (err: unknown) {
      fastify.log.error({ err }, "Failed to verify Stripe webhook signature.");
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `Webhook Error: ${message}` });
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

    await db.transaction(async (tx) => {
      switch (event.type) {
        case "account.updated": {
          const account = event.data.object as Stripe.Account;
          if (account.details_submitted) {
            fastify.log.info(
              { accountId: account.id },
              "Account details submitted, updating client record."
            );
            await tx
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
        case "payment_intent.succeeded":
        case "payment_intent.payment_failed": {
          const intent = event.data.object as Stripe.PaymentIntent;
          fastify.log.info(
            { intentId: intent.id, status: intent.status },
            "PaymentIntent event received."
          );
          break;
        }
        case "charge.refunded": {
          const charge = event.data.object as Stripe.Charge;
          fastify.log.info(
            { chargeId: charge.id, amountRefunded: charge.amount_refunded },
            "Charge refunded."
          );
          break;
        }
        case "payout.paid":
        case "payout.failed": {
          const payout = event.data.object as Stripe.Payout;
          fastify.log.info(
            { payoutId: payout.id, status: payout.status },
            "Payout event received."
          );
          break;
        }
        case "invoice.payment_succeeded": {
          const inv = event.data.object as Stripe.Invoice;
          fastify.log.info(
            { invoiceId: inv.id, clientId: inv.metadata?.clientId },
            "Invoice payment succeeded."
          );
          break;
        }
        case "invoice.payment_failed": {
          const inv = event.data.object as Stripe.Invoice;
          fastify.log.warn(
            { invoiceId: inv.id, clientId: inv.metadata?.clientId },
            "Invoice payment failed."
          );
          break;
        }
        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          fastify.log.info(
            { subId: sub.id, status: sub.status, clientId: sub.metadata?.clientId },
            "Subscription updated."
          );
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          fastify.log.info(
            { subId: sub.id, clientId: sub.metadata?.clientId },
            "Subscription deleted."
          );
          break;
        }
        default: {
          fastify.log.debug({ eventType: event.type }, "Unhandled Stripe event type.");
        }
      }

      await tx
        .update(webhookEvents)
        .set({ processedAt: new Date() })
        .where(eq(webhookEvents.stripeEventId, event.id));
    });

    return reply.send({ received: true });
  });
}
