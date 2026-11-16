import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/client";
import { connectInvoices } from "../../db/schema";
import { type InvoiceRow, serializeInvoice } from "../../lib/connect-invoice";
import { applyStripeInvoice } from "../../lib/connect-invoice-sync";
import { INVOICE_CLAIM_LEASE_MS } from "../../lib/constants";
import { stripe } from "../../lib/stripe";
import { parseBody } from "../../lib/validation";
import {
  INVOICE_NOT_FOUND,
  type InvoicingDeps,
  idParamsSchema,
  REQUEST_REJECTED,
  type RequestWithClient,
} from "./shared";

// ══ Invoice lifecycle: finalize, send, void, delete ════════════════════════
// Every call uses the account the ROW was created on. If the client has been moved to another
// account, nothing is sent (ACCOUNT_CHANGED). Results are written back with applyStripeInvoice,
// which never moves a status backward.

export const lifecycleErr = (reply: FastifyReply, status: number, code: string, error: string) =>
  reply.code(status).send({ error, code });

/** The caller's invoice (any creation state), or undefined after sending 404 / ACCOUNT_CHANGED. */
export async function loadLifecycleRow(
  request: FastifyRequest,
  reply: FastifyReply,
  stripeInvoiceId: string
): Promise<InvoiceRow | undefined> {
  const client = (request as RequestWithClient).client;
  const [row] = await db
    .select()
    .from(connectInvoices)
    .where(
      and(
        eq(connectInvoices.clientId, client.id),
        eq(connectInvoices.stripeInvoiceId, stripeInvoiceId)
      )
    )
    .limit(1);
  if (!row) {
    reply.code(404).send(INVOICE_NOT_FOUND);
    return undefined;
  }
  if (row.connectedAccountId !== client.stripeAccountId) {
    lifecycleErr(
      reply,
      409,
      "ACCOUNT_CHANGED",
      "The client's Stripe account changed since this invoice was created. It cannot be changed from this API key."
    );
    return undefined;
  }
  return row;
}

/** Runs a Postgres write that follows a Stripe success; a failure is a 503 the caller retries. */
export async function persistAfterStripe<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  row: InvoiceRow,
  write: () => Promise<T>,
  // Runs before the 503 leaves, so a caller that retries at once finds the work released.
  beforeReply?: () => Promise<unknown>,
  // For a write after which the same request would no longer be retried as is.
  message = "The invoice was updated but confirmation failed. Please retry the same request."
): Promise<T | undefined> {
  try {
    return await write();
  } catch (err) {
    // SQLSTATE only: the driver error quotes the failed query's parameters (hosted URLs).
    const dbCode = (err as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code;
    request.log.error(
      { clientId: row.clientId, invoiceRowId: row.id, dbCode },
      "Invoice change done on Stripe but not recorded; returning 503"
    );
    await beforeReply?.();
    reply.code(503).send({
      error: message,
      code: "LEDGER_PERSISTENCE_FAILED",
    });
    return undefined;
  }
}

export const invoiceIdParams = (request: FastifyRequest, reply: FastifyReply) =>
  parseBody(idParamsSchema, request.params, reply);

/**
 * Takes the row's claim lease (the one a create holds) for the length of a lifecycle write, so
 * finalize, void and delete never overlap each other or a create that is still adding lines. A
 * live claim is 409 INVOICE_IN_USE (the write token is given back). The claim is released before
 * ANY response leaves (the onSend hook), whatever path the handler takes.
 */
export async function claimInvoice(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  row: InvoiceRow,
  opts: { draftOnly?: boolean; deletedIsOk?: boolean } = {}
): Promise<boolean> {
  const claimAt = new Date();
  const [claimed] = await db
    .update(connectInvoices)
    .set({ claimedAt: claimAt })
    .where(
      and(
        eq(connectInvoices.id, row.id),
        opts.draftOnly
          ? eq(connectInvoices.status, "draft")
          : ne(connectInvoices.status, "deleted"),
        or(
          isNull(connectInvoices.claimedAt),
          lt(connectInvoices.claimedAt, new Date(claimAt.getTime() - INVOICE_CLAIM_LEASE_MS))
        )
      )
    )
    .returning();
  if (!claimed) {
    await deps.writeBucket.refund(request);
    const [latest] = await db
      .select()
      .from(connectInvoices)
      .where(eq(connectInvoices.id, row.id))
      .limit(1);
    if (opts.deletedIsOk && latest?.status === "deleted") {
      reply.code(200).send(serializeInvoice(latest));
    } else if (latest?.status === "deleted") {
      lifecycleErr(reply, 409, "INVOICE_DELETED", "The invoice was deleted.");
    } else {
      lifecycleErr(
        reply,
        409,
        "INVOICE_IN_USE",
        "The invoice is being created or changed right now. Retry shortly."
      );
    }
    return false;
  }
  deps.pendingRelease.set(request, () =>
    db
      .update(connectInvoices)
      .set({ claimedAt: null })
      .where(and(eq(connectInvoices.id, row.id), eq(connectInvoices.claimedAt, claimAt)))
      .then(() => undefined)
      .catch(() => undefined)
  );
  return true;
}

// Stripe refusing a finalize, void or delete with a 400 means the invoice is no longer in the
// state we expected (a race, or a dashboard action). That is not the caller's mistake: the
// invoice is re-read, recorded, and reported as a 409 with its current status.
/** A Stripe invalid-request answer to a lifecycle write, carried back to the handler. */
export class Rejected {
  constructor(readonly err: unknown) {}
}
const isStateRejection = (err: unknown) => {
  const e = err as { type?: unknown; code?: unknown } | null;
  return (
    e?.type === "StripeInvalidRequestError" &&
    e.code !== "resource_missing" &&
    e.code !== "idempotency_key_in_use"
  );
};
export const rejectable =
  <T>(fn: () => Promise<T>) =>
  async (): Promise<T | Rejected> => {
    try {
      return await fn();
    } catch (err) {
      if (isStateRejection(err)) return new Rejected(err);
      throw err;
    }
  };

/** Codes and ids only: Stripe's message can quote an email or a hosted URL. */
export const logRejection = (
  request: FastifyRequest,
  row: InvoiceRow,
  action: string,
  err: unknown,
  stripeStatus?: string | null
) => {
  const e = err as { code?: unknown; type?: unknown; statusCode?: unknown } | null;
  request.log.warn(
    {
      clientId: row.clientId,
      invoiceRowId: row.id,
      stripeInvoiceId: row.stripeInvoiceId,
      requestId: request.id,
      action,
      stripeCode: e?.code,
      stripeType: e?.type,
      stripeStatusCode: e?.statusCode,
      stripeInvoiceStatus: stripeStatus,
    },
    "Stripe refused an invoice change"
  );
};

/**
 * Stripe refused a finalize, void or delete with a 400. The invoice is re-read and recorded; then
 * either its status really moved away from what the operation needs (a race, or a dashboard
 * action): 409 INVOICE_STATE_CHANGED with the current status, or it did not: a genuine
 * rejection, a generic 502. Stripe's own message is never returned.
 */
export async function replyAfterRejection(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  row: InvoiceRow,
  action: string,
  required: readonly string[],
  err: unknown
) {
  const stripeAccount = row.connectedAccountId;
  const invoiceId = row.stripeInvoiceId as string;
  const fresh = await deps.stripeCall(
    request,
    reply,
    "invoices.retrieve",
    () => stripe.invoices.retrieve(invoiceId, {}, { stripeAccount }),
    { notFound: "Invoice not found.", generic: true }
  );
  if (!fresh) return reply;
  logRejection(request, row, action, err, fresh.status);
  const updated = await persistAfterStripe(request, reply, row, () =>
    applyStripeInvoice(db, row, fresh)
  );
  if (!updated) return reply;
  if (fresh.status && required.includes(fresh.status)) {
    return reply.code(502).send(REQUEST_REJECTED);
  }
  return reply.code(409).send({
    error: `The invoice changed state and is now ${updated.status}. Nothing was changed.`,
    code: "INVOICE_STATE_CHANGED",
    status: updated.status,
  });
}
