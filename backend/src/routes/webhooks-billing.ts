import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { markCustomerDirty } from "../lib/billing-snapshot";
import { stripe } from "../lib/stripe";
import {
  claimStripeEvent,
  markStripeEventProcessed,
  releaseStripeEvent,
} from "../lib/webhook-lease";

// The ACCOUNT-level Stripe webhook for DFWSC's own billing (the platform account: invoices and
// subscriptions of billing_customers). It is a different endpoint from /webhooks/stripe, whose
// secret belongs to the Connect-level endpoint and never sees these events.
//
// An event never carries data into the snapshot: the Customer is looked up in billing_customers
// and its snapshot is only marked dirty; the refresh re-reads Stripe (lib/billing-snapshot.ts).
// Read-only toward Stripe: this route makes no Stripe call at all.

export const BILLING_WEBHOOK_EVENTS = [
  "invoice.created",
  "invoice.finalized",
  "invoice.updated",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "invoice.overdue",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "subscription_schedule.created",
  "subscription_schedule.updated",
  "subscription_schedule.canceled",
  "subscription_schedule.completed",
  "subscription_schedule.released",
] as const;

const HANDLED = new Set<string>(BILLING_WEBHOOK_EVENTS);

function customerIdOf(event: Stripe.Event): string | null {
  const customer = (event.data.object as { customer?: string | { id?: string } | null }).customer;
  if (typeof customer === "string") return customer;
  return customer && typeof customer.id === "string" ? customer.id : null;
}

export default async function billingWebhookRoute(fastify: FastifyInstance) {
  fastify.post(
    "/webhooks/stripe-billing",
    { config: { rawBody: true } },
    async (request, reply) => {
      // Read per request: unset means the endpoint does not exist.
      const secret = process.env.STRIPE_BILLING_WEBHOOK_SECRET?.trim();
      if (!secret) return reply.code(404).send({ error: "Not Found" });

      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string") {
        return reply.code(400).send({ error: "Missing Stripe-Signature header." });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(request.rawBody as string, signature, secret);
      } catch (err: unknown) {
        fastify.log.error({ err }, "Failed to verify Stripe billing webhook signature.");
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: `Webhook Error: ${message}` });
      }

      // HARD GUARD: an event of a connected account belongs to the Connect side. Never act on it.
      if (event.account) return reply.send({ received: true });
      if (!HANDLED.has(event.type)) return reply.send({ received: true });

      const claim = await claimStripeEvent(event);
      if (claim === "processed") return reply.send({ received: true });
      if (claim === "in_progress") {
        return reply.code(409).send({ error: "Webhook processing in progress" });
      }

      try {
        const customerId = customerIdOf(event);
        const known = customerId ? await markCustomerDirty(customerId) : false;
        fastify.log.info(
          { eventId: event.id, eventType: event.type, known },
          "Billing webhook handled."
        );
      } catch (err) {
        await releaseStripeEvent(event.id);
        fastify.log.error(
          { err, eventId: event.id, eventType: event.type },
          "Billing webhook processing failed; released claim so Stripe can retry"
        );
        return reply.code(500).send({ error: "Webhook processing failed" });
      }

      await markStripeEventProcessed(event.id);
      return reply.send({ received: true });
    }
  );
}
