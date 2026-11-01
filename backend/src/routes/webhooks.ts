import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clients, paymentLedger } from "../db/schema";
import { isCircuitOpenError, isStripeBusyError, withStripeCircuit } from "../lib/circuit-breakers";
import { syncConnectInvoice } from "../lib/connect-invoice-sync";
import { isUniqueViolation } from "../lib/errors";
import { stripe } from "../lib/stripe";
import { mapStripeError } from "../lib/stripe-errors";
import {
  claimStripeEvent,
  markStripeEventProcessed,
  releaseStripeEvent,
} from "../lib/webhook-lease";

// A DB error is non-retryable when replaying the same Stripe event would fail
// identically (e.g. a Postgres unique violation) — retrying would only wedge
// Stripe's retry queue, so we mark the event processed instead of returning 500.
function isNonRetryableDbError(err: unknown): boolean {
  return isUniqueViolation(err);
}

// Only identifiers: a Stripe error message can quote customer data (emails, hosted URLs).
function isStripeError(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("Stripe");
}

// Stripe errors log identifiers only. Anything else is our own bug, whose message and stack are
// the only way to find it.
function retryErrorFields(err: unknown) {
  if (isStripeError(err) || !(err instanceof Error)) return safeErrorFields(err);
  return { ...safeErrorFields(err), errMessage: err.message, errStack: err.stack };
}

function safeErrorFields(err: unknown) {
  const e = err as {
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
    name?: unknown;
  } | null;
  return {
    errType: e?.type ?? e?.name,
    errCode: e?.code,
    errStatusCode: e?.statusCode,
    errRequestId: e?.requestId,
  };
}

const CIRCUIT_OPEN_ERROR = { error: "Stripe service temporarily unavailable" };

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
 *
 * `attachPaymentIntentId` (session lookups only) records the PaymentIntent id
 * on the row. A Checkout Session's PaymentIntent does not exist when the ledger
 * row is created, so this is the only place the id is learned; without it every
 * later PaymentIntent-keyed event (refunds, disputes, failures) finds no row.
 * It is identity data, not status, so it is persisted even when the status
 * update is skipped as stale or as a precedence downgrade.
 */
async function updateLedgerStatus(
  lookup: { stripeSessionId?: string; stripePaymentIntentId?: string },
  newStatus: LedgerStatus,
  eventCreatedAt: number,
  logger: FastifyBaseLogger,
  options: { refundedAmountCents?: number; attachPaymentIntentId?: string } = {}
): Promise<void> {
  const { refundedAmountCents, attachPaymentIntentId } = options;
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
      stripePaymentIntentId: paymentLedger.stripePaymentIntentId,
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

  // Decide whether to record the PaymentIntent id (never overwrite a different one).
  let paymentIntentIdToAttach: string | undefined;
  if (lookup.stripeSessionId && attachPaymentIntentId) {
    if (existing.stripePaymentIntentId === null) {
      paymentIntentIdToAttach = attachPaymentIntentId;
    } else if (existing.stripePaymentIntentId !== attachPaymentIntentId) {
      logger.warn(
        {
          ledgerId: existing.id,
          existingPaymentIntentId: existing.stripePaymentIntentId,
          incomingPaymentIntentId: attachPaymentIntentId,
        },
        "Ledger row already has a different PaymentIntent id; not overwriting"
      );
    }
  }

  // Persist the PaymentIntent id without touching status/ordering, for the
  // early returns below where the status update itself is skipped.
  const attachOnly = async (): Promise<void> => {
    if (!paymentIntentIdToAttach) return;
    await db
      .update(paymentLedger)
      .set({ stripePaymentIntentId: paymentIntentIdToAttach, updatedAt: new Date() })
      .where(eq(paymentLedger.id, existing.id));
  };

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
    await attachOnly();
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
    await attachOnly();
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

  if (paymentIntentIdToAttach) {
    updateData.stripePaymentIntentId = paymentIntentIdToAttach;
  }

  // Track refunded amount for partial vs full refund distinction.
  if (refundedAmountCents !== undefined) {
    const currentRefunded = existing.refundedAmountCents ?? 0;
    // Take the maximum refunded amount seen (handles partial refunds accumulating).
    updateData.refundedAmountCents = Math.max(currentRefunded, refundedAmountCents);
  }

  await db.update(paymentLedger).set(updateData).where(eq(paymentLedger.id, existing.id));
}

// The PaymentIntent id carried by a Checkout Session event, when present as a
// string (webhook payloads are not expanded). Null for sessions that never
// created a PaymentIntent.
function sessionPaymentIntentId(session: Stripe.Checkout.Session): string | undefined {
  return typeof session.payment_intent === "string" && session.payment_intent.length > 0
    ? session.payment_intent
    : undefined;
}

export type CheckoutSessionOutcome = "completed" | "expired" | "async_succeeded" | "async_failed";

/**
 * Apply a Checkout Session outcome to the ledger. This is the single place the
 * checkout.session.* transition rules live: the webhook handler and the
 * payment status endpoint's Stripe fallback both go through it.
 *
 * `completed` only means the customer finished checkout. For delayed-notification
 * methods (bank debits) Stripe sends it with payment_status "unpaid" and settles
 * later via async_payment_succeeded / async_payment_failed, so the row is marked
 * paid only when the money is actually secured ("paid" or "no_payment_required").
 * Otherwise the row stays "created" (still recording the PaymentIntent id) and
 * the async events decide.
 */
export async function applyCheckoutSessionOutcome(
  outcome: CheckoutSessionOutcome,
  session: Stripe.Checkout.Session,
  eventCreatedAt: number,
  logger: FastifyBaseLogger
): Promise<void> {
  const options = { attachPaymentIntentId: sessionPaymentIntentId(session) };
  const lookup = { stripeSessionId: session.id };

  switch (outcome) {
    case "completed": {
      const settled =
        session.payment_status === "paid" || session.payment_status === "no_payment_required";
      logger.info(
        { sessionId: session.id, paymentStatus: session.payment_status, settled },
        settled
          ? "Checkout session completed."
          : "Checkout session completed but payment is not settled; awaiting async payment events."
      );
      await updateLedgerStatus(
        lookup,
        settled ? "paid" : "created",
        eventCreatedAt,
        logger,
        options
      );
      break;
    }
    case "expired":
      logger.info({ sessionId: session.id }, "Checkout session expired.");
      await updateLedgerStatus(lookup, "expired", eventCreatedAt, logger, options);
      break;
    case "async_succeeded":
      logger.info({ sessionId: session.id }, "Checkout async payment succeeded.");
      await updateLedgerStatus(lookup, "paid", eventCreatedAt, logger, options);
      break;
    case "async_failed":
      logger.info({ sessionId: session.id }, "Checkout async payment failed.");
      await updateLedgerStatus(lookup, "failed", eventCreatedAt, logger, options);
      break;
  }
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
    if (isCircuitOpenError(err) || isStripeBusyError(err)) {
      // Let the outer handler deal with it: the event must not be marked processed, so
      // Stripe redelivers it.
      throw err;
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
      await applyCheckoutSessionOutcome("completed", session, eventCreatedAt, logger);
      break;
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      await applyCheckoutSessionOutcome("expired", session, eventCreatedAt, logger);
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      await applyCheckoutSessionOutcome("async_succeeded", session, eventCreatedAt, logger);
      break;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await applyCheckoutSessionOutcome("async_failed", session, eventCreatedAt, logger);
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
          { refundedAmountCents: charge.amount_refunded }
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
    case "invoice.finalized":
    case "invoice.sent":
    case "invoice.paid":
    case "invoice.payment_succeeded": // alias of invoice.paid
    case "invoice.voided":
    case "invoice.marked_uncollectible":
    case "invoice.updated":
    case "invoice.deleted": {
      await syncConnectInvoice(event, logger);
      break;
    }
    case "invoice.payment_failed": {
      await syncConnectInvoice(event, logger);
      // The only signal of a failed payment attempt: the invoice itself stays open.
      const inv = event.data.object as Stripe.Invoice;
      logger.warn({ invoiceId: inv.id, accountId: event.account }, "Invoice payment failed.");
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

    // Only the delivery that wins the lease may process the event (see lib/webhook-lease.ts).
    const claim = await claimStripeEvent(event);
    // Already fully processed: idempotent 200.
    if (claim === "processed") return reply.send({ received: true });
    // A live lease is held by another in-flight delivery. Return non-2xx so Stripe retries later
    // rather than dropping the event: a concurrent duplicate must NOT ack until some delivery
    // marks it done.
    if (claim === "in_progress") {
      return reply.code(409).send({ error: "Webhook processing in progress" });
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
        await releaseStripeEvent(event.id);
        fastify.log.error(
          { ...retryErrorFields(err), eventId: event.id, eventType: event.type },
          "Webhook event processing failed; released claim so Stripe can retry"
        );
        if (mapStripeError(err, reply, { circuitOpen: CIRCUIT_OPEN_ERROR })) return;
        return reply.code(500).send({ error: "Webhook processing failed" });
      }
    }

    await markStripeEventProcessed(event.id);

    return reply.send({ received: true });
  });
}
