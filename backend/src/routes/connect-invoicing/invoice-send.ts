import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { connectInvoiceSends, connectInvoices } from "../../db/schema";
import {
  isCircuitOpenError,
  isStripeBusyError,
  withStripeCircuit,
} from "../../lib/circuit-breakers";
import { classifySendError, type InvoiceRow, serializeInvoice } from "../../lib/connect-invoice";
import { applyStripeInvoice } from "../../lib/connect-invoice-sync";
import { INVOICE_CLAIM_LEASE_MS, INVOICE_MAX_SENDS } from "../../lib/constants";
import { stripe } from "../../lib/stripe";
import { mapStripeError } from "../../lib/stripe-errors";
import {
  invoiceIdParams,
  lifecycleErr,
  loadLifecycleRow,
  logRejection,
  persistAfterStripe,
} from "./invoice-lifecycle-helpers";
import {
  INVOICE_NOT_FOUND,
  type InvoicingDeps,
  invoiceKeyInUse,
  isResourceMissing,
  parseIdempotencyKeyHash,
  type RequestWithClient,
  STRIPE_CIRCUIT_OPEN_ERROR,
} from "./shared";

// Each accepted Idempotency-Key is a connect_invoice_sends row, taken in a transaction that
// holds a lock on the invoice, so the cap of INVOICE_MAX_SENDS counts exactly. 'pending' and
// 'sent' count; 'failed' (a definite Stripe rejection: nothing was emailed) does not. A replay
// of a sent key answers from Postgres and never reaches Stripe or the count. A failed key is
// never retried: Stripe would replay its stored error for 24 hours, so the caller needs a new key.
type SendDecision =
  | { kind: "replay" }
  | { kind: "in_use" }
  | { kind: "limit" }
  | { kind: "failed" }
  | { kind: "not_open"; status: string }
  | { kind: "go"; sendId: string };

type SendPatch = Partial<typeof connectInvoiceSends.$inferInsert>;
const updateSend = (sendId: string, patch: SendPatch) =>
  db.update(connectInvoiceSends).set(patch).where(eq(connectInvoiceSends.id, sendId));
type SetSend = (patch: SendPatch) => ReturnType<typeof updateSend>;

/** Under a lock on the invoice, decides what this Idempotency-Key may do and records a new send. */
async function decideSend(
  row: InvoiceRow,
  clientId: string,
  keyHash: string
): Promise<SendDecision> {
  return db.transaction(async (tx): Promise<SendDecision> => {
    const [locked] = await tx
      .select({ status: connectInvoices.status })
      .from(connectInvoices)
      .where(eq(connectInvoices.id, row.id))
      .for("update");
    const now = new Date();
    const [existing] = await tx
      .select()
      .from(connectInvoiceSends)
      .where(
        and(eq(connectInvoiceSends.invoiceId, row.id), eq(connectInvoiceSends.keyHash, keyHash))
      )
      .limit(1);
    if (existing) {
      if (existing.state === "sent") return { kind: "replay" };
      if (existing.state === "failed") return { kind: "failed" };
      const live =
        existing.claimedAt !== null &&
        existing.claimedAt.getTime() > now.getTime() - INVOICE_CLAIM_LEASE_MS;
      if (live) return { kind: "in_use" };
      // Pending with an expired claim: it already counts, so no cap check. Same Stripe key.
      await tx
        .update(connectInvoiceSends)
        .set({ claimedAt: now })
        .where(eq(connectInvoiceSends.id, existing.id));
      return { kind: "go", sendId: existing.id };
    }
    if (locked?.status !== "open") return { kind: "not_open", status: locked?.status ?? "unknown" };
    const [counted] = await tx
      .select({ n: count() })
      .from(connectInvoiceSends)
      .where(
        and(
          eq(connectInvoiceSends.invoiceId, row.id),
          inArray(connectInvoiceSends.state, ["pending", "sent"])
        )
      );
    if (counted.n >= INVOICE_MAX_SENDS) return { kind: "limit" };
    const sendId = uuidv4();
    await tx.insert(connectInvoiceSends).values({
      id: sendId,
      invoiceId: row.id,
      clientId,
      keyHash,
      state: "pending",
      claimedAt: now,
    });
    return { kind: "go", sendId };
  });
}

/** The reply for a key that may not send (anything but "go"). Nothing goes to Stripe. */
async function replyForRefusedSend(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  row: InvoiceRow,
  decision: Exclude<SendDecision, { kind: "go" }>
) {
  // Nothing goes to Stripe, so the token is given back.
  await deps.writeBucket.refund(request);
  if (decision.kind === "replay") {
    const [current] = await db
      .select()
      .from(connectInvoices)
      .where(eq(connectInvoices.id, row.id))
      .limit(1);
    return reply.code(200).send(serializeInvoice(current ?? row));
  }
  if (decision.kind === "in_use") return invoiceKeyInUse(reply);
  if (decision.kind === "failed") {
    return lifecycleErr(
      reply,
      409,
      "SEND_FAILED",
      "This send failed. Use a new Idempotency-Key to try again."
    );
  }
  if (decision.kind === "limit") {
    return lifecycleErr(
      reply,
      409,
      "SEND_LIMIT_REACHED",
      `An invoice can be sent at most ${INVOICE_MAX_SENDS} times.`
    );
  }
  return lifecycleErr(
    reply,
    409,
    "INVOICE_NOT_SENDABLE",
    `Only open invoices can be sent; this one is ${decision.status}.`
  );
}

interface SendFailure {
  row: InvoiceRow;
  clientId: string;
  invoiceId: string;
  stripeAccount: string;
  err: unknown;
  setSend: SetSend;
}

/**
 * Stripe refused the send for good: nothing was emailed, so it does not use up a send. The key is
 * recorded as failed, the invoice re-read, and the reply says why. Stripe's own message is never
 * returned.
 */
async function replyForRejectedSend(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  f: SendFailure
) {
  const { row, invoiceId, stripeAccount, err, setSend } = f;
  await persistAfterStripe(request, reply, row, () =>
    setSend({ state: "failed", claimedAt: null })
  );
  if (reply.sent) return reply;
  // Re-read the invoice: if it is no longer open (a send that lost to a void, or a payment),
  // that is the answer. Stripe's own message is never returned.
  const fresh = await deps.stripeCall(
    request,
    reply,
    "invoices.retrieve",
    () => stripe.invoices.retrieve(invoiceId, {}, { stripeAccount }),
    { notFound: "Invoice not found.", generic: true }
  );
  if (!fresh) return reply;
  logRejection(request, row, "invoices.sendInvoice", err, fresh.status);
  // This key is already recorded as failed (a retry of it answers 409 SEND_FAILED), so the
  // caller must not be told to retry the same request.
  const refreshed = await persistAfterStripe(
    request,
    reply,
    row,
    () => applyStripeInvoice(db, row, fresh),
    undefined,
    "Stripe rejected the send and the invoice status could not be recorded. Check the invoice status, then use a new Idempotency-Key to try again."
  );
  if (!refreshed) return reply;
  if (fresh.status !== "open") {
    return reply.code(409).send({
      error: `The invoice is now ${refreshed.status} and cannot be sent.`,
      code: "INVOICE_STATE_CHANGED",
      status: refreshed.status,
    });
  }
  const rejection = err as { type?: unknown; code?: unknown } | null;
  if (isResourceMissing(err)) return reply.code(404).send(INVOICE_NOT_FOUND);
  if (rejection?.type === "StripePermissionError") {
    return reply.code(409).send({
      error: "Client Stripe account is not connected or cannot accept charges.",
      code: "ACCOUNT_NOT_CONNECTED",
    });
  }
  if (rejection?.type === "StripeIdempotencyError") {
    return reply.code(409).send({
      error:
        "Stripe could not accept this send. Check the invoice status and try again with a new Idempotency-Key.",
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  }
  return reply.code(502).send({
    error: "Stripe refused to send the invoice.",
    code: "SEND_REJECTED",
  });
}

/** The reply for a failed sendInvoice call: still running, refused for good, or outcome unknown. */
async function replyForSendError(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  f: SendFailure & { called: boolean }
) {
  const { clientId, err, setSend, called } = f;
  const e = err as { code?: unknown; type?: unknown } | null;
  request.log.error(
    { clientId, action: "invoices.sendInvoice", stripeCode: e?.code, stripeType: e?.type },
    "Connected-account invoicing Stripe call failed"
  );
  if (isStripeBusyError(err) || (isCircuitOpenError(err) && !called)) {
    await deps.writeBucket.refund(request);
  }
  const kind = classifySendError(err);
  if (kind === "in_progress") {
    // The first attempt with this key is still running at Stripe: it stays pending.
    await setSend({ claimedAt: null }).catch(() => undefined);
    return reply.code(409).send({
      error:
        "A request with this Idempotency-Key is still in progress. Retry shortly with the same key.",
      code: "IDEMPOTENCY_KEY_IN_USE",
    });
  }
  if (kind === "rejected") return replyForRejectedSend(deps, request, reply, f);
  // Unknown outcome (network, 5xx, rate limit, circuit): the email may have gone out. The row
  // stays pending and counts; the same key retries it.
  await setSend({ claimedAt: null }).catch(() => undefined);
  if (mapStripeError(err, reply, { circuitOpen: STRIPE_CIRCUIT_OPEN_ERROR })) return reply;
  return reply.code(503).header("Retry-After", "5").send({
    error:
      "The send could not be confirmed. Retry with the same Idempotency-Key; it will not be sent twice.",
    code: "SEND_STATUS_UNKNOWN",
  });
}

/** POST /invoices/:id/send: email an open invoice (capped, idempotent per key). */
export function registerInvoiceSendRoutes(fastify: FastifyInstance, deps: InvoicingDeps) {
  fastify.post("/invoices/:id/send", { preHandler: deps.chargeGuards }, async (request, reply) => {
    const params = invoiceIdParams(request, reply);
    if (!params) return;
    const clientId = (request as RequestWithClient).client.id;
    const keyHash = parseIdempotencyKeyHash(request);

    const row = await loadLifecycleRow(request, reply, params.id);
    if (!row) return reply;
    if (row.creationState !== "complete") {
      return lifecycleErr(reply, 409, "INVOICE_INCOMPLETE", "The invoice is still being created.");
    }
    if (!(await deps.takeWriteToken(request, reply))) return reply;

    const decision = await decideSend(row, clientId, keyHash);
    if (decision.kind !== "go") return replyForRefusedSend(deps, request, reply, row, decision);

    const sendId = decision.sendId;
    const setSend: SetSend = (patch) => updateSend(sendId, patch);
    const stripeAccount = row.connectedAccountId;
    const invoiceId = row.stripeInvoiceId as string;

    let called = false;
    let sent: Stripe.Invoice;
    try {
      sent = await withStripeCircuit(() => {
        called = true;
        return stripe.invoices.sendInvoice(
          invoiceId,
          {},
          { stripeAccount, idempotencyKey: `${clientId}:${invoiceId}:send:${keyHash}` }
        );
      });
    } catch (err) {
      return replyForSendError(deps, request, reply, {
        row,
        clientId,
        invoiceId,
        stripeAccount,
        err,
        setSend,
        called,
      });
    }

    const updated = await persistAfterStripe(
      request,
      reply,
      row,
      () =>
        db.transaction(async (tx) => {
          // Same lock the cap check takes: concurrent sends record one at a time, so each count of
          // 'sent' rows below includes every send that finished before it.
          await tx
            .select({ id: connectInvoices.id })
            .from(connectInvoices)
            .where(eq(connectInvoices.id, row.id))
            .for("update");
          await tx
            .update(connectInvoiceSends)
            .set({ state: "sent", claimedAt: null })
            .where(eq(connectInvoiceSends.id, sendId));
          return applyStripeInvoice(tx, row, sent, {
            sentAt: new Date(),
            sendCount:
              sql`(select count(*)::int from ${connectInvoiceSends} where ${connectInvoiceSends.invoiceId} = ${row.id} and ${connectInvoiceSends.state} = 'sent')` as unknown as number,
          });
        }),
      // Stripe has it; the same key retries the (idempotent) call and records it.
      () => setSend({ claimedAt: null }).catch(() => undefined)
    );
    if (!updated) return reply;
    return reply.code(200).send(serializeInvoice(updated));
  });
}
