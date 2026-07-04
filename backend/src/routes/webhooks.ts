import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { clients, webhookEvents } from "../db/schema";
import { isUniqueViolation } from "../lib/errors";
import { stripe } from "../lib/stripe";

// A DB error is non-retryable when replaying the same Stripe event would fail
// identically (e.g. a Postgres unique violation) — retrying would only wedge
// Stripe's retry queue, so we mark the event processed instead of returning 500.
function isNonRetryableDbError(err: unknown): boolean {
  return isUniqueViolation(err);
}

export default async function webhooksRoute(fastify: FastifyInstance) {
  // Validate required environment variable at route registration time
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

    // Atomically claim this event: only the delivery whose INSERT actually
    // lands a row is allowed to process it. Concurrent retries of the same
    // event will race on the unique index and lose the claim, so they must
    // short-circuit rather than double-process.
    const [claimed] = await db
      .insert(webhookEvents)
      .values({
        id: uuidv4(),
        stripeEventId: event.id,
        type: event.type,
        payload: JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: webhookEvents.stripeEventId })
      .returning({ id: webhookEvents.id });

    if (!claimed) {
      // A prior delivery already claimed (and possibly processed) this event.
      return reply.send({ received: true });
    }

    try {
      switch (event.type) {
        case "account.updated": {
          const account = event.data.object as Stripe.Account;
          fastify.log.info(
            {
              accountId: account.id,
              detailsSubmitted: account.details_submitted,
              chargesEnabled: account.charges_enabled,
              payoutsEnabled: account.payouts_enabled,
            },
            "Account updated, syncing client readiness."
          );
          await db
            .update(clients)
            .set({
              chargesEnabled: account.charges_enabled ?? false,
              payoutsEnabled: account.payouts_enabled ?? false,
              detailsSubmitted: account.details_submitted ?? false,
              updatedAt: new Date(),
            })
            .where(eq(clients.stripeAccountId, account.id));
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
            // TODO: application-fee reversal policy is a business decision
            "Charge refunded."
          );
          break;
        }
        case "application_fee.refunded": {
          const fee = event.data.object as Stripe.ApplicationFee;
          fastify.log.info(
            { feeId: fee.id, amountRefunded: fee.amount_refunded },
            // TODO: application-fee reversal policy is a business decision
            "Application fee refunded."
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
        case "customer.subscription.paused": {
          const sub = event.data.object as Stripe.Subscription;
          fastify.log.info(
            { subId: sub.id, clientId: sub.metadata?.clientId },
            "Subscription paused."
          );
          break;
        }
        case "customer.subscription.resumed": {
          const sub = event.data.object as Stripe.Subscription;
          fastify.log.info(
            { subId: sub.id, clientId: sub.metadata?.clientId },
            "Subscription resumed."
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
        case "invoice.paid": {
          const inv = event.data.object as Stripe.Invoice;
          const rawSub = inv.parent?.subscription_details?.subscription ?? null;
          const subId = typeof rawSub === "string" ? rawSub : (rawSub?.id ?? null);
          fastify.log.info(
            {
              invoiceId: inv.id,
              subscriptionId: subId,
              clientId: inv.metadata?.clientId,
            },
            "Invoice paid - updating payment count."
          );

          if (subId) {
            // Let failures propagate to the outer catch so the webhook returns
            // 500 and processedAt stays unset, prompting Stripe to retry.
            const sub = await stripe.subscriptions.retrieve(subId);
            const currentPayments = parseInt(sub.metadata?.paymentsMade ?? "0", 10) || 0;
            await stripe.subscriptions.update(subId, {
              metadata: {
                ...sub.metadata,
                paymentsMade: String(currentPayments + 1),
                lastPaidAt: new Date().toISOString(),
              },
            });

            const scheduleId = typeof sub.schedule === "string" ? sub.schedule : null;
            if (scheduleId) {
              const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
              const schedulePaid = parseInt(schedule.metadata?.paymentsMade ?? "0", 10) || 0;
              await stripe.subscriptionSchedules.update(scheduleId, {
                metadata: {
                  ...schedule.metadata,
                  paymentsMade: String(schedulePaid + 1),
                  lastPaidAt: new Date().toISOString(),
                },
              });
            }
          }
          break;
        }
        case "subscription_schedule.completed": {
          const schedule = event.data.object as Stripe.SubscriptionSchedule;
          fastify.log.info(
            { scheduleId: schedule.id, clientId: schedule.metadata?.clientId },
            "Subscription schedule completed - all payments made."
          );

          await stripe.subscriptionSchedules.update(schedule.id, {
            metadata: {
              ...schedule.metadata,
              status: "completed",
              completedAt: new Date().toISOString(),
            },
          });
          break;
        }
        case "subscription_schedule.canceled": {
          const schedule = event.data.object as Stripe.SubscriptionSchedule;
          fastify.log.info(
            { scheduleId: schedule.id, clientId: schedule.metadata?.clientId },
            "Subscription schedule cancelled."
          );
          break;
        }
        default: {
          fastify.log.debug({ eventType: event.type }, "Unhandled Stripe event type.");
        }
      }
    } catch (err) {
      if (isNonRetryableDbError(err)) {
        // A DB constraint (e.g. unique violation) will never succeed on retry.
        // Log it and still mark the event processed so a single bad event
        // can't wedge the retry queue for every subsequent delivery.
        fastify.log.error(
          { err, eventId: event.id, eventType: event.type },
          "Webhook event hit a non-retryable DB error; marking processed anyway"
        );
      } else {
        // Retryable failure: release the claim so Stripe's retry can re-process.
        // The row was inserted before processing to dedup concurrent deliveries;
        // if we returned 500 without deleting it, every retry would conflict on
        // the unique index, short-circuit as "already handled", and the event
        // would stay claimed-but-unprocessed forever. Deleting restores
        // at-least-once delivery (handlers must remain idempotent).
        await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
        fastify.log.error(
          { err, eventId: event.id, eventType: event.type },
          "Webhook event processing failed; released claim so Stripe can retry"
        );
        return reply.code(500).send({ error: "Webhook processing failed" });
      }
    }

    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.stripeEventId, event.id));

    return reply.send({ received: true });
  });
}
