import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { connectInvoices } from "../db/schema";
import { isCircuitOpenError, isStripeBusyError, withStripeCircuit } from "./circuit-breakers";
import {
  INVOICE_STATUS_PRIORS,
  type InvoiceRow,
  type InvoiceStatus,
  invoicePatchFromStripe,
} from "./connect-invoice";
import { stripe } from "./stripe";

// Writes Stripe's view of a connected-account invoice onto its connect_invoices row. Shared by the
// API routes (lifecycle writes, the GET re-check) and the Connect webhook, so there is one place
// that decides what a row may become. Hosted URLs and PDF links are bearer links: nothing here
// logs them, only ids and codes.

type Exec = Pick<typeof db, "update" | "select">;
type RowExtra = Partial<typeof connectInvoices.$inferInsert>;

/**
 * Writes a patch onto a row, never moving the status backward (INVOICE_STATUS_PRIORS). When the
 * guard refuses (the row is already further along) the stored row is returned unchanged.
 * `extra` carries columns only the caller knows. Throws on a Postgres failure.
 */
async function applyInvoicePatch(
  exec: Exec,
  row: InvoiceRow,
  patch: { status: InvoiceStatus } & RowExtra,
  extra: RowExtra
): Promise<InvoiceRow> {
  const [updated] = await exec
    .update(connectInvoices)
    .set({ ...patch, ...extra })
    .where(
      and(
        eq(connectInvoices.id, row.id),
        inArray(connectInvoices.status, [...INVOICE_STATUS_PRIORS[patch.status]])
      )
    )
    .returning();
  if (updated) return updated;
  const [current] = await exec
    .select()
    .from(connectInvoices)
    .where(eq(connectInvoices.id, row.id))
    .limit(1);
  return current ?? row;
}

/** Writes what Stripe says about an invoice onto its row (status guard applies). */
export async function applyStripeInvoice(
  exec: Exec,
  row: InvoiceRow,
  invoice: Stripe.Invoice,
  extra: RowExtra = {}
): Promise<InvoiceRow> {
  const patch = invoicePatchFromStripe(invoice);
  if (!patch) return row;
  return applyInvoicePatch(exec, row, patch, extra);
}

/**
 * How a failed re-read of an invoice is handled.
 * - `missing`: Stripe has no such invoice (404 or resource_missing).
 * - `ack`: a definite answer about this one invoice that a retry cannot change (a 400 invalid
 *   request that is not about credentials).
 * - `retry`: anything that can heal or be fixed: a bad or rotated key (401), a permission error
 *   (403), a rate limit (429), a lock (409), 5xx, network errors, timeouts. The webhook answers
 *   non-2xx so Stripe redelivers, rather than dropping the only push signal.
 */
export type InvoiceReadErrorClass = "missing" | "ack" | "retry";

const AUTH_ERROR_TYPES = new Set(["StripeAuthenticationError", "StripePermissionError"]);

export function classifyInvoiceReadError(err: unknown): InvoiceReadErrorClass {
  const e = err as { statusCode?: unknown; code?: unknown; type?: unknown } | null;
  const status = typeof e?.statusCode === "number" ? e.statusCode : undefined;
  if (status === 404 || e?.code === "resource_missing") return "missing";
  if (status !== 400) return "retry";
  if (typeof e?.type === "string" && AUTH_ERROR_TYPES.has(e.type)) return "retry";
  if (typeof e?.code === "string" && /^(api_key|account_invalid|platform_)/.test(e.code)) {
    return "retry";
  }
  return "ack";
}

/**
 * Syncs one `invoice.*` event of the Connect webhook. The payload is never trusted: the invoice is
 * re-read on the event's account, so an old or replayed event writes the current state, and the
 * status guard stops any backward move.
 *
 * Returns normally to acknowledge the event. Throws (so the webhook answers non-2xx and Stripe
 * redelivers) on an open circuit, a busy limiter, a 5xx, a 429 or a connection error.
 */
export async function syncConnectInvoice(
  event: Stripe.Event,
  logger: FastifyBaseLogger
): Promise<void> {
  const log = { eventId: event.id, eventType: event.type };
  // A platform invoice event belongs to the billing webhook (routes/webhooks-billing.ts).
  if (!event.account) {
    logger.debug(log, "Invoice event without an account; not a connected-account invoice.");
    return;
  }
  const account = event.account;
  const invoiceId = (event.data.object as { id?: unknown } | null)?.id;
  if (typeof invoiceId !== "string") {
    logger.warn(log, "Invoice event without an invoice id; ignored.");
    return;
  }

  const [row] = await db
    .select()
    .from(connectInvoices)
    .where(
      and(
        eq(connectInvoices.stripeInvoiceId, invoiceId),
        eq(connectInvoices.connectedAccountId, account)
      )
    )
    .limit(1);
  if (!row) {
    logger.debug(log, "Invoice event for an invoice this API did not create; ignored.");
    return;
  }
  // The create flow's own final read owns a row until it is complete.
  if (row.creationState !== "complete") {
    logger.debug(log, "Invoice event for a row still being created; ignored.");
    return;
  }

  let invoice: Stripe.Invoice;
  try {
    invoice = await withStripeCircuit(() =>
      stripe.invoices.retrieve(invoiceId, {}, { stripeAccount: account })
    );
  } catch (err) {
    if (isCircuitOpenError(err) || isStripeBusyError(err)) throw err;
    const kind = classifyInvoiceReadError(err);
    if (kind === "retry") throw err;
    if (kind === "missing") {
      // Only a draft can be deleted: the status guard refuses anything further along.
      const after = await applyInvoicePatch(
        db,
        row,
        { status: "deleted", lastSyncedAt: new Date() },
        eventStamp(event)
      );
      if (after.status !== "deleted") {
        logger.warn(
          { ...log, rowId: row.id, invoiceId, accountId: account, status: after.status },
          "Invoice is missing on Stripe but the row is past draft; left as is."
        );
      }
      return;
    }
    // Codes only: Stripe's message can quote customer data.
    logger.warn(
      { ...log, stripeCode: (err as { code?: unknown } | null)?.code },
      "Invoice event could not be synced; Stripe refused the read."
    );
    return;
  }

  const extra: RowExtra = eventStamp(event);
  if (event.type === "invoice.sent") {
    // A send from the Stripe dashboard. It records when, but is not an API send: send_count and
    // the per-key send rows (the API's cap) are left alone.
    extra.sentAt =
      sql`COALESCE(${connectInvoices.sentAt}, to_timestamp(${event.created}))` as never;
  }
  await applyStripeInvoice(db, row, invoice, extra);
}

/** Diagnostic only (never a skip gate): the newest event time seen for the row. */
function eventStamp(event: Stripe.Event): RowExtra {
  return {
    lastStripeEventCreatedAt:
      sql`GREATEST(COALESCE(${connectInvoices.lastStripeEventCreatedAt}, 0), ${event.created})` as never,
  };
}
