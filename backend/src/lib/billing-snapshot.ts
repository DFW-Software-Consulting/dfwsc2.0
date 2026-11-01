import { eq, inArray, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "../db/client";
import { billingCustomers, billingSnapshots } from "../db/schema";
import {
  type BillingInput,
  type BillingInvoiceInput,
  type BillingScheduleInput,
  type BillingSubscriptionInput,
  type BillingValues,
  deriveBilling,
} from "./billing-status";
import { isCircuitOpenError, isStripeBusyError, withStripeCircuit } from "./circuit-breakers";
import { type MirrorLogger, withMirrorLock } from "./mirror-table";
import { contentHash } from "./portal-mirror-render";
import { stripe } from "./stripe";

// billing_snapshots: the Stripe-derived state of each billing Customer (DFWSC's own clients, on
// the PLATFORM account; unrelated to Stripe Connect), kept for the Client Billing mirror.
//
// STRICTLY READ-ONLY toward Stripe: this module only calls list methods. The result is always
// derived from those lists, never from a webhook payload; a webhook only marks a snapshot dirty.

const PAGE_SIZE = 100;
// A Customer with more than this many subscriptions, schedules or invoices is refused, not cut.
const MAX_PAGES = 20;
const REFRESH_LOCK_NAME = "billing_snapshot_refresh";
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

async function listAll<T extends { id: string }>(
  fetchPage: (startingAfter: string | undefined) => Promise<Stripe.ApiList<T>>
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await withStripeCircuit(() => fetchPage(startingAfter));
    all.push(...batch.data);
    const last = batch.data[batch.data.length - 1];
    if (!batch.has_more || !last) return all;
    startingAfter = last.id;
  }
  throw new Error("billing snapshot: too many Stripe objects to list");
}

// Per refresh and Customer, at most this many invoices get their payment looked up; past it, an
// attempted charge_automatically invoice keeps the conservative "failed" reading.
const MAX_PAYMENT_LOOKUPS = 10;

// Only a permanent client error (4xx such as 404, or an unexpected object shape) makes one invoice
// read as failed. Everything else (connection, timeout, 5xx, 429, circuit open, busy) propagates,
// so the refresh backs off and the previous snapshot stays.
const isPermanentLookupError = (error: unknown) =>
  error instanceof Stripe.errors.StripeInvalidRequestError || error instanceof TypeError;

/**
 * For each open, attempted charge_automatically invoice (the only ones whose overdue state
 * depends on it) looks up its latest InvoicePayment (invoicePayments.list) and that payment's
 * PaymentIntent (retrieve, unless already an object), and returns the invoice with only that
 * payment attached. Other invoices are untouched; no call at all when none qualifies. A
 * non-transient failure leaves the invoice without payment data (read as failed) and warns;
 * every other error (connection, timeout, 5xx, rate limit, circuit open, busy) propagates to the refresh's backoff.
 */
async function attachLatestPayments(
  customerId: string,
  invoices: Stripe.Invoice[],
  logger: MirrorLogger
): Promise<Stripe.Invoice[]> {
  let lookups = 0;
  let skipped = 0;
  const out: Stripe.Invoice[] = [];
  for (const invoice of invoices) {
    const qualifies =
      invoice.status === "open" &&
      invoice.amount_remaining > 0 &&
      invoice.collection_method === "charge_automatically" &&
      (invoice.attempt_count ?? 0) > 0 &&
      invoice.id;
    if (!qualifies) {
      out.push(invoice);
      continue;
    }
    if (lookups >= MAX_PAYMENT_LOOKUPS) {
      skipped += 1;
      out.push(invoice);
      continue;
    }
    lookups += 1;
    try {
      const id = invoice.id as string;
      const payments = await withStripeCircuit(() =>
        stripe.invoicePayments.list({ invoice: id, limit: 10 })
      );
      const latest = payments.data.reduce<Stripe.InvoicePayment | null>(
        (best, p) => (best === null || p.created > best.created ? p : best),
        null
      );
      if (!latest) {
        out.push(invoice);
        continue;
      }
      let pi = latest.payment?.payment_intent;
      if (typeof pi === "string") {
        const piId = pi;
        pi = await withStripeCircuit(() => stripe.paymentIntents.retrieve(piId));
      }
      const payment = {
        ...latest.payment,
        payment_intent: pi ? { id: pi.id, status: pi.status } : null,
      };
      out.push({
        ...invoice,
        payments: { data: [{ ...latest, payment }] },
      } as unknown as Stripe.Invoice);
    } catch (error) {
      if (!isPermanentLookupError(error)) throw error;
      logger.warn(
        {
          customerId,
          invoiceId: invoice.id,
          errorCode: (error as { code?: string })?.code ?? (error as Error)?.name,
        },
        "Billing snapshot: payment lookup failed for an invoice; it reads as failed."
      );
      out.push(invoice);
    }
  }
  if (skipped)
    logger.warn(
      { customerId, skipped, cap: MAX_PAYMENT_LOOKUPS },
      "Billing snapshot: payment lookup cap reached; remaining attempted invoices read as failed."
    );
  return out;
}

/** The only Stripe calls of the billing snapshot. All are reads. */
async function fetchBillingInput(
  customerId: string,
  now: Date,
  logger: MirrorLogger
): Promise<BillingInput> {
  const subscriptions = await listAll((startingAfter) =>
    stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: PAGE_SIZE,
      expand: ["data.schedule"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
  // Schedules that have not started have no subscription yet, so the list above cannot show them.
  const schedules = await listAll((startingAfter) =>
    stripe.subscriptionSchedules.list({
      customer: customerId,
      scheduled: true,
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
  const invoices = await listAll((startingAfter) =>
    stripe.invoices.list({
      customer: customerId,
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
  // API 2025-09-30.clover has no invoice.payment_intent: payments come from invoicePayments.list.
  const withPayments = await attachLatestPayments(customerId, invoices, logger);
  return {
    subscriptions: subscriptions as unknown as BillingSubscriptionInput[],
    schedules: schedules as unknown as BillingScheduleInput[],
    invoices: withPayments as unknown as BillingInvoiceInput[],
    now,
  };
}

// startedAt reached us as a JS Date (millisecond precision) while dirty_at has microseconds, hence
// the extra millisecond: a mark set during that millisecond still predates every Stripe read.
/**
 * Re-derives the snapshot of every client code on this Customer. `updated_at` moves only when the
 * content hash does, so the mirror sees real changes. `dirty_at` is cleared only if no webhook
 * marked it after `startedAt` (the database clock when this refresh began).
 * Returns the number of snapshots whose content changed.
 */
async function refreshCustomer(
  customerId: string,
  startedAt: Date,
  logger: MirrorLogger
): Promise<number> {
  const codes = await db
    .select({ clientCode: billingCustomers.clientCode })
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, customerId));
  if (!codes.length) return 0;

  const values: BillingValues = deriveBilling(
    await fetchBillingInput(customerId, startedAt, logger)
  );
  const hash = contentHash({ ...values, nonUsd: String(values.nonUsd) });
  const existing = new Map(
    (
      await db
        .select({ clientCode: billingSnapshots.clientCode, hash: billingSnapshots.contentHash })
        .from(billingSnapshots)
        .where(
          inArray(
            billingSnapshots.clientCode,
            codes.map((c) => c.clientCode)
          )
        )
    ).map((r) => [r.clientCode, r.hash])
  );

  let changed = 0;
  for (const { clientCode } of codes) {
    const bookkeeping = {
      stripeCustomerId: customerId,
      refreshedAt: new Date(),
      attempts: 0,
      lastError: null,
      dirtyAt: sql`CASE WHEN ${billingSnapshots.dirtyAt} < ${startedAt}::timestamptz + interval '1 millisecond' THEN NULL ELSE ${billingSnapshots.dirtyAt} END`,
    };
    if (!existing.has(clientCode)) {
      await db
        .insert(billingSnapshots)
        .values({
          clientCode,
          stripeCustomerId: customerId,
          rendered: values,
          contentHash: hash,
          refreshedAt: new Date(),
        })
        .onConflictDoNothing();
      changed += 1;
    } else if (existing.get(clientCode) !== hash) {
      await db
        .update(billingSnapshots)
        .set({ ...bookkeeping, rendered: values, contentHash: hash, updatedAt: new Date() })
        .where(eq(billingSnapshots.clientCode, clientCode));
      changed += 1;
    } else {
      await db
        .update(billingSnapshots)
        .set(bookkeeping)
        .where(eq(billingSnapshots.clientCode, clientCode));
    }
  }
  return changed;
}

/**
 * Customers to refresh: all of them (sweep), or those with no snapshot yet, no successful refresh
 * yet or marked dirty. Stalest first (never refreshed, then oldest refreshed_at), so a run cut
 * short by a rate limit continues with the Customers it did not reach.
 */
async function customersToRefresh(all: boolean): Promise<string[]> {
  const bc = billingCustomers;
  const bs = billingSnapshots;
  const rows = await db
    .select({ id: bc.stripeCustomerId })
    .from(bc)
    .leftJoin(bs, eq(bs.clientCode, bc.clientCode))
    .groupBy(bc.stripeCustomerId)
    .having(
      all
        ? undefined
        : sql`bool_or(${bs.clientCode} IS NULL OR ${bs.rendered} IS NULL OR ${bs.dirtyAt} IS NOT NULL)`
    )
    .orderBy(sql`min(${bs.refreshedAt}) ASC NULLS FIRST`, sql`min(${bc.clientCode})`);
  return rows.map((r) => r.id);
}

/** Sets dirty_at on the snapshots of a Customer; true when the Customer is known at all. */
export async function markCustomerDirty(customerId: string): Promise<boolean> {
  const known = await db
    .select({ clientCode: billingCustomers.clientCode })
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, customerId))
    .limit(1);
  if (!known.length) return false;
  await db
    .update(billingSnapshots)
    .set({ dirtyAt: sql`now()` })
    .where(eq(billingSnapshots.stripeCustomerId, customerId));
  return true;
}

// In-process retry backoff per Customer (a failing Customer must not be retried every cycle).
const backoff = new Map<string, { failures: number; notBefore: number }>();

export function resetBillingSnapshotStateForTests() {
  backoff.clear();
}

const isRateLimited = (error: unknown) =>
  error instanceof Stripe.errors.StripeRateLimitError ||
  (error as { statusCode?: number } | null)?.statusCode === 429;

async function recordFailure(customerId: string, error: unknown) {
  const previous = backoff.get(customerId)?.failures ?? 0;
  backoff.set(customerId, {
    failures: previous + 1,
    notBefore: Date.now() + Math.min(RETRY_BASE_MS * 2 ** previous, RETRY_MAX_MS),
  });
  const lastError = ((error as Error)?.name ?? "Error").slice(0, 200);
  // A Customer whose first refresh fails gets a row too (rendered NULL), so the mirror can say
  // "Check failed" instead of showing nothing.
  const codes = await db
    .select({ clientCode: billingCustomers.clientCode })
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, customerId));
  for (const { clientCode } of codes) {
    await db
      .insert(billingSnapshots)
      .values({ clientCode, stripeCustomerId: customerId, attempts: 1, lastError })
      .onConflictDoUpdate({
        target: billingSnapshots.clientCode,
        set: { attempts: sql`${billingSnapshots.attempts} + 1`, lastError },
      });
  }
}

export interface BillingRefreshResult {
  status: "ok" | "busy" | "stopped";
  refreshed: number;
  changed: number;
  failed: number;
}

/**
 * Refreshes dirty snapshots (`all: false`) or every Customer (`all: true`, the sweep), one
 * Customer at a time under an advisory lock, `gapMs` apart. A Stripe outage (circuit open, busy)
 * or a rate limit ends the run; any other failure is recorded and the run continues.
 */
export async function runBillingRefresh(options: {
  logger: MirrorLogger;
  all: boolean;
  gapMs?: number;
}): Promise<BillingRefreshResult> {
  const { logger, all, gapMs = 250 } = options;
  const out: BillingRefreshResult = { status: "ok", refreshed: 0, changed: 0, failed: 0 };
  return withMirrorLock(
    REFRESH_LOCK_NAME,
    logger,
    { ...out, status: "busy" as const },
    async (startedAt) => {
      const customers = await customersToRefresh(all);
      let first = true;
      for (const customerId of customers) {
        if ((backoff.get(customerId)?.notBefore ?? 0) > Date.now()) continue;
        if (!first && gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
        first = false;
        try {
          out.changed += await refreshCustomer(customerId, startedAt, logger);
          out.refreshed += 1;
          backoff.delete(customerId);
        } catch (error) {
          if (isCircuitOpenError(error) || isStripeBusyError(error) || isRateLimited(error)) {
            out.status = "stopped";
            logger.warn(
              { errorName: (error as Error).name },
              "Billing refresh stopped: Stripe unavailable or rate limited."
            );
            return out;
          }
          out.failed += 1;
          logger.warn(
            { customerId, errorName: (error as Error)?.name },
            "Billing refresh failed for a Customer; will retry with backoff."
          );
          await recordFailure(customerId, error);
        }
      }
      if (out.refreshed || out.failed) {
        logger.info(
          { all, refreshed: out.refreshed, changed: out.changed, failed: out.failed },
          "Billing refresh finished."
        );
      }
      return out;
    }
  );
}
