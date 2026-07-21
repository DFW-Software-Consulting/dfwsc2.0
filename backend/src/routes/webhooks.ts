import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { clients, paymentLedger, webhookEvents } from "../db/schema";
import { isCircuitOpenError, withStripeCircuit } from "../lib/circuit-breakers";
import { isUniqueViolation } from "../lib/errors";
import { stripe } from "../lib/stripe";
import { mapStripeError } from "../lib/stripe-errors";

// A DB error is non-retryable when replaying the same Stripe event would fail
// identically (e.g. a Postgres unique violation) — retrying would only wedge
// Stripe's retry queue, so we mark the event processed instead of returning 500.
function isNonRetryableDbError(err: unknown): boolean {
  return isUniqueViolation(err);
}

const CIRCUIT_OPEN_ERROR = { error: "Stripe service temporarily unavailable" };

// How long a claim row can remain unprocessed before we consider the
// claiming process to have crashed and allow another delivery to reclaim it.
const STALE_CLAIM_MS = 15 * 60 * 1000;

// ── Ledger update helpers ──────────────────────────────────────────────────────

type LedgerStatus =
  | "created"
  | "paid"
  | "expired"
  | "failed"
  | "refunded"
  | "disputed"
  | "canceled";

// Status precedence (higher index = higher precedence, cannot be downgraded):
// created < expired/failed/canceled < paid < refunded < disputed
const STATUS_PRECEDENCE: Record<LedgerStatus, number> = {
  created: 0,
  expired: 1,
  failed: 1,
  canceled: 1,
  paid: 2,
  refunded: 3,
  disputed: 4,
};

/**
 * Update a payment ledger row by session ID or payment intent ID.
 * Uses lastStripeEventCreatedAt to ignore out-of-order events.
 * Enforces status precedence: refunded/disputed cannot be overwritten by paid.
 */
async function updateLedgerStatus(
  lookup: { stripeSessionId?: string; stripePaymentIntentId?: string },
  newStatus: LedgerStatus,
  eventCreatedAt: number,
  logger: FastifyBaseLogger,
  refundedAmountCents?: number
): Promise<void> {
  let condition: ReturnType<typeof eq> | undefined;
  if (lookup.stripeSessionId) {
    condition = eq(paymentLedger.stripeSessionId, lookup.stripeSessionId);
  } else if (lookup.stripePaymentIntentId) {
    condition = eq(paymentLedger.stripePaymentIntentId, lookup.stripePaymentIntentId);
  } else {
    return;
  }

  // Find existing row first to check ordering and precedence.
  const [existing] = await db
    .select({
      id: paymentLedger.id,
      lastStripeEventCreatedAt: paymentLedger.lastStripeEventCreatedAt,
      status: paymentLedger.status,
      refundedAmountCents: paymentLedger.refundedAmountCents,
    })
    .from(paymentLedger)
    .where(condition)
    .limit(1);

  if (!existing) {
    logger.debug(
      { lookup, newStatus },
      "No ledger row found for event; skipping (row must be created by payment creation endpoint)"
    );
    return;
  }

  // Ordering protection: ignore stale events (same-second events use precedence).
  if (
    existing.lastStripeEventCreatedAt !== null &&
    existing.lastStripeEventCreatedAt > eventCreatedAt
  ) {
    logger.info(
      {
        ledgerId: existing.id,
        existingEventAt: existing.lastStripeEventCreatedAt,
        incomingEventAt: eventCreatedAt,
      },
      "Ignoring out-of-order Stripe event for ledger update"
    );
    return;
  }

  // Status precedence: cannot downgrade from refunded/disputed to paid.
  const existingPrecedence = STATUS_PRECEDENCE[existing.status as LedgerStatus] ?? 0;
  const newPrecedence = STATUS_PRECEDENCE[newStatus] ?? 0;
  if (existingPrecedence > newPrecedence) {
    logger.debug(
      { ledgerId: existing.id, existingStatus: existing.status, newStatus },
      "Ledger status precedence prevents downgrade"
    );
    return;
  }

  // For same-second events with same precedence, use deterministic ordering:
  // prefer the "worse" status (refunded > paid, disputed > refunded).
  // If truly same status, allow the update (idempotent).

  const updateData: Record<string, unknown> = {
    status: newStatus,
    lastStripeEventCreatedAt: eventCreatedAt,
    updatedAt: new Date(),
  };

  // Track refunded amount for partial vs full refund distinction.
  if (refundedAmountCents !== undefined) {
    const currentRefunded = existing.refundedAmountCents ?? 0;
    // Take the maximum refunded amount seen (handles partial refunds accumulating).
    updateData.refundedAmountCents = Math.max(currentRefunded, refundedAmountCents);
  }

  await db.update(paymentLedger).set(updateData).where(eq(paymentLedger.id, existing.id));
}

/**
 * For account.updated events, retrieve the current state from Stripe
 * rather than trusting the event payload. This handles out-of-order
 * delivery: we always write the latest state regardless of event ordering.
 */
async function syncAccountFromStripe(accountId: string, logger: FastifyBaseLogger): Promise<void> {
  let account: Stripe.Account;
  try {
    account = await withStripeCircuit(() => stripe.accounts.retrieve(accountId));
  } catch (err) {
    if (isCircuitOpenError(err)) {
      throw err; // Let the outer handler deal with circuit open.
    }
    logger.warn(
      { err, accountId },
      "Failed to retrieve current account state from Stripe; skipping sync"
    );
    return;
  }

  logger.info(
    {
      accountId: account.id,
      detailsSubmitted: account.details_submitted,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
    },
    "Account updated, syncing client readiness from current Stripe state."
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
}

async function processEvent(event: Stripe.Event, logger: FastifyBaseLogger): Promise<void> {
  const eventCreatedAt = event.created;

  switch (event.type) {
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      // Retrieve current state from Stripe to handle out-of-order events.
      await syncAccountFromStripe(account.id, logger);
      break;
    }
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      logger.info(
        { sessionId: session.id, paymentStatus: session.payment_status },
        "Checkout session completed."
      );
      await updateLedgerStatus({ stripeSessionId: session.id }, "paid", eventCreatedAt, logger);
      // If the session has a payment_intent, also update by PI ID.
      if (session.payment_intent && typeof session.payment_intent === "string") {
        await updateLedgerStatus(
          { stripePaymentIntentId: session.payment_intent },
          "paid",
          eventCreatedAt,
          logger
        );
      }
      break;
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      logger.info({ sessionId: session.id }, "Checkout session expired.");
      await updateLedgerStatus({ stripeSessionId: session.id }, "expired", eventCreatedAt, logger);
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      logger.info({ sessionId: session.id }, "Checkout async payment succeeded.");
      await updateLedgerStatus({ stripeSessionId: session.id }, "paid", eventCreatedAt, logger);
      break;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      logger.info({ sessionId: session.id }, "Checkout async payment failed.");
      await updateLedgerStatus({ stripeSessionId: session.id }, "failed", eventCreatedAt, logger);
      break;
    }
    case "payment_intent.succeeded": {
      const intent = event.data.object as Stripe.PaymentIntent;
      logger.info({ intentId: intent.id, status: intent.status }, "PaymentIntent succeeded.");
      await updateLedgerStatus(
        { stripePaymentIntentId: intent.id },
        "paid",
        eventCreatedAt,
        logger
      );
      break;
    }
    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent;
      logger.info({ intentId: intent.id, status: intent.status }, "PaymentIntent failed.");
      await updateLedgerStatus(
        { stripePaymentIntentId: intent.id },
        "failed",
        eventCreatedAt,
        logger
      );
      break;
    }
    case "payment_intent.canceled": {
      const intent = event.data.object as Stripe.PaymentIntent;
      logger.info({ intentId: intent.id }, "PaymentIntent canceled.");
      await updateLedgerStatus(
        { stripePaymentIntentId: intent.id },
        "canceled",
        eventCreatedAt,
        logger
      );
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      logger.info(
        { chargeId: charge.id, amountRefunded: charge.amount_refunded },
        "Charge refunded."
      );
      // Map refund to the payment intent if available.
      // Track refunded amount for partial vs full refund distinction.
      if (charge.payment_intent && typeof charge.payment_intent === "string") {
        await updateLedgerStatus(
          { stripePaymentIntentId: charge.payment_intent },
          "refunded",
          eventCreatedAt,
          logger,
          charge.amount_refunded
        );
      }
      break;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      logger.info({ disputeId: dispute.id, charge: dispute.charge }, "Dispute created.");
      // Retrieve the charge to find the payment intent.
      // Use event.account (connected account context) for the retrieval.
      if (typeof dispute.charge === "string") {
        const connectedAccount = event.account;
        const charge = await withStripeCircuit(() =>
          stripe.charges.retrieve(
            dispute.charge as string,
            connectedAccount ? { stripeAccount: connectedAccount } : {}
          )
        );
        if (charge.payment_intent && typeof charge.payment_intent === "string") {
          await updateLedgerStatus(
            { stripePaymentIntentId: charge.payment_intent },
            "disputed",
            eventCreatedAt,
            logger
          );
        }
      }
      break;
    }
    case "application_fee.refunded": {
      const fee = event.data.object as Stripe.ApplicationFee;
      logger.info(
        { feeId: fee.id, amountRefunded: fee.amount_refunded },
        // TODO: application-fee reversal policy is a business decision
        "Application fee refunded."
      );
      break;
    }
    case "payout.paid":
    case "payout.failed": {
      const payout = event.data.object as Stripe.Payout;
      logger.info({ payoutId: payout.id, status: payout.status }, "Payout event received.");
      break;
    }
    case "invoice.payment_succeeded": {
      const inv = event.data.object as Stripe.Invoice;
      logger.info(
        { invoiceId: inv.id, clientId: inv.metadata?.clientId },
        "Invoice payment succeeded."
      );
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      logger.warn(
        { invoiceId: inv.id, clientId: inv.metadata?.clientId },
        "Invoice payment failed."
      );
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      logger.info(
        { subId: sub.id, status: sub.status, clientId: sub.metadata?.clientId },
        "Subscription updated."
      );
      break;
    }
    case "customer.subscription.paused": {
      const sub = event.data.object as Stripe.Subscription;
      logger.info({ subId: sub.id, clientId: sub.metadata?.clientId }, "Subscription paused.");
      break;
    }
    case "customer.subscription.resumed": {
      const sub = event.data.object as Stripe.Subscription;
      logger.info({ subId: sub.id, clientId: sub.metadata?.clientId }, "Subscription resumed.");
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      logger.info({ subId: sub.id, clientId: sub.metadata?.clientId }, "Subscription deleted.");
      break;
    }
    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      const rawSub = inv.parent?.subscription_details?.subscription ?? null;
      const subId = typeof rawSub === "string" ? rawSub : (rawSub?.id ?? null);
      logger.info(
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
        const sub = await withStripeCircuit(() => stripe.subscriptions.retrieve(subId));

        // Derive the paid-invoice count from Stripe itself rather than a
        // read-modify-write increment. This makes the handler idempotent:
        // replaying the same invoice.paid event yields the same total instead
        // of double-counting, and a retry after a partial failure re-applies
        // the identical value. Count distinct PAID invoices for this
        // subscription across all pages.
        const paidInvoiceIds = new Set<string>();
        let startingAfter: string | undefined;
        for (;;) {
          const page = await withStripeCircuit(() =>
            stripe.invoices.list({
              subscription: subId,
              status: "paid",
              limit: 100,
              ...(startingAfter ? { starting_after: startingAfter } : {}),
            })
          );
          for (const item of page.data) {
            if (item.id) paidInvoiceIds.add(item.id);
          }
          if (!page.has_more || page.data.length === 0) break;
          const last = page.data[page.data.length - 1];
          if (!last?.id) break;
          startingAfter = last.id;
        }
        const paymentsMade = String(paidInvoiceIds.size);
        const nowIso = new Date().toISOString();

        // Guard the subscription update independently so a retry after a
        // partial failure (subscription updated, schedule not) is a no-op on
        // the side that already holds the derived value.
        if (sub.metadata?.paymentsMade !== paymentsMade) {
          await withStripeCircuit(() =>
            stripe.subscriptions.update(subId, {
              metadata: {
                ...sub.metadata,
                paymentsMade,
                lastPaidAt: nowIso,
              },
            })
          );
        }

        const scheduleId = typeof sub.schedule === "string" ? sub.schedule : null;
        if (scheduleId) {
          const schedule = await withStripeCircuit(() =>
            stripe.subscriptionSchedules.retrieve(scheduleId)
          );
          // Independent guard: apply the SAME derived count to the schedule
          // regardless of whether the subscription side was already updated.
          if (schedule.metadata?.paymentsMade !== paymentsMade) {
            await withStripeCircuit(() =>
              stripe.subscriptionSchedules.update(scheduleId, {
                metadata: {
                  ...schedule.metadata,
                  paymentsMade,
                  lastPaidAt: nowIso,
                },
              })
            );
          }
        }
      }
      break;
    }
    case "subscription_schedule.completed": {
      const schedule = event.data.object as Stripe.SubscriptionSchedule;
      logger.info(
        { scheduleId: schedule.id, clientId: schedule.metadata?.clientId },
        "Subscription schedule completed - all payments made."
      );

      await withStripeCircuit(() =>
        stripe.subscriptionSchedules.update(schedule.id, {
          metadata: {
            ...schedule.metadata,
            status: "completed",
            completedAt: new Date().toISOString(),
          },
        })
      );
      break;
    }
    case "subscription_schedule.canceled": {
      const schedule = event.data.object as Stripe.SubscriptionSchedule;
      logger.info(
        { scheduleId: schedule.id, clientId: schedule.metadata?.clientId },
        "Subscription schedule cancelled."
      );
      break;
    }
    default: {
      logger.debug({ eventType: event.type }, "Unhandled Stripe event type.");
    }
  }
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

    // Atomically claim this event via a reclaimable lease. A claim consists of
    // a row for this stripeEventId whose `claimedAt` is a fresh lease. Only the
    // delivery that wins the claim may process the event; concurrent duplicate
    // deliveries either observe it already processed (idempotent 200) or find a
    // live lease and are told to retry later. A lease older than STALE_CLAIM_MS
    // is assumed abandoned by a crashed processor and may be reclaimed.
    const leaseCutoff = new Date(Date.now() - STALE_CLAIM_MS);

    // First try: insert a fresh row + lease. Wins the claim when no row exists.
    const [inserted] = await db
      .insert(webhookEvents)
      .values({
        id: uuidv4(),
        stripeEventId: event.id,
        type: event.type,
        claimedAt: new Date(),
      })
      .onConflictDoNothing({ target: webhookEvents.stripeEventId })
      .returning({ id: webhookEvents.id });

    if (!inserted) {
      // A row already exists. Decide: already done, reclaimable, or in-flight.
      const [existing] = await db
        .select({ processedAt: webhookEvents.processedAt })
        .from(webhookEvents)
        .where(eq(webhookEvents.stripeEventId, event.id))
        .limit(1);
      if (existing?.processedAt) {
        // Already fully processed → true idempotent no-op.
        return reply.send({ received: true });
      }

      // Attempt to (re)claim the lease atomically. Succeeds only if the event
      // is still unprocessed AND the lease is absent or stale. If a live lease
      // is held by another in-flight delivery, no row is returned.
      const [reclaimed] = await db
        .update(webhookEvents)
        .set({ claimedAt: new Date() })
        .where(
          and(
            eq(webhookEvents.stripeEventId, event.id),
            isNull(webhookEvents.processedAt),
            or(isNull(webhookEvents.claimedAt), lt(webhookEvents.claimedAt, leaseCutoff))
          )
        )
        .returning({ id: webhookEvents.id });

      if (!reclaimed) {
        // Unprocessed event with a live lease held by another delivery. Return
        // non-2xx so Stripe retries later rather than dropping the event — a
        // concurrent duplicate must NOT ack until some delivery marks it done.
        return reply.code(409).send({ error: "Webhook processing in progress" });
      }
    }

    try {
      await processEvent(event, fastify.log);
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
        if (mapStripeError(err, reply, { circuitOpen: CIRCUIT_OPEN_ERROR })) return;
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
