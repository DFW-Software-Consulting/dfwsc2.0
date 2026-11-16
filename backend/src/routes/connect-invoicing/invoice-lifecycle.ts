import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { db } from "../../db/client";
import { connectInvoices } from "../../db/schema";
import { INVOICE_STATUS_PRIORS, serializeInvoice } from "../../lib/connect-invoice";
import { applyStripeInvoice } from "../../lib/connect-invoice-sync";
import { stripe } from "../../lib/stripe";
import {
  claimInvoice,
  invoiceIdParams,
  lifecycleErr,
  loadLifecycleRow,
  persistAfterStripe,
  Rejected,
  rejectable,
  replyAfterRejection,
} from "./invoice-lifecycle-helpers";
import { type InvoicingDeps, isResourceMissing, type RequestWithClient } from "./shared";

// Every call uses the account the ROW was created on. If the client has been moved to another
// account, nothing is sent (ACCOUNT_CHANGED). Results are written back with applyStripeInvoice,
// which never moves a status backward.

/** Invoice lifecycle writes: finalize, void and delete. */
export function registerInvoiceLifecycleRoutes(fastify: FastifyInstance, deps: InvoicingDeps) {
  const { chargeGuards, lifecycleOpenGuards, stripeCall, takeWriteToken } = deps;

  // ── POST /invoices/:id/finalize ────────────────────────────────────────────
  fastify.post("/invoices/:id/finalize", { preHandler: chargeGuards }, async (request, reply) => {
    const params = invoiceIdParams(request, reply);
    if (!params) return;
    const clientId = (request as RequestWithClient).client.id;
    const row = await loadLifecycleRow(request, reply, params.id);
    if (!row) return reply;
    if (row.creationState !== "complete") {
      return lifecycleErr(
        reply,
        409,
        "INVOICE_INCOMPLETE",
        "The invoice is still being created. Retry the create with its Idempotency-Key first."
      );
    }
    if (row.status === "deleted") {
      return lifecycleErr(reply, 409, "INVOICE_NOT_FINALIZABLE", "The invoice was deleted.");
    }
    if (!(await takeWriteToken(request, reply))) return reply;
    if (!(await claimInvoice(deps, request, reply, row))) return reply;

    const stripeAccount = row.connectedAccountId;
    const invoiceId = row.stripeInvoiceId as string;
    const fresh = await stripeCall(
      request,
      reply,
      "invoices.retrieve",
      () => stripe.invoices.retrieve(invoiceId, {}, { stripeAccount }),
      { write: true, notFound: "Invoice not found.", generic: true }
    );
    if (!fresh) return reply;

    let result: Stripe.Invoice = fresh;
    if (fresh.status === "draft") {
      // The total is what the fee and the caller agreed to. If Stripe now disagrees, nothing is
      // finalized: a finalized invoice can no longer be corrected.
      if (fresh.total !== row.totalCents) {
        request.log.error(
          {
            clientId,
            stripeInvoiceId: invoiceId,
            expectedTotalCents: row.totalCents,
            stripeTotalCents: fresh.total,
          },
          "Stripe invoice total changed since creation; not finalizing"
        );
        return lifecycleErr(
          reply,
          502,
          "INVOICE_TOTAL_MISMATCH",
          "The invoice total no longer matches the amount computed at creation. It was not finalized."
        );
      }
      const finalized = await stripeCall(
        request,
        reply,
        "invoices.finalizeInvoice",
        rejectable(() =>
          stripe.invoices.finalizeInvoice(
            invoiceId,
            { auto_advance: false },
            { stripeAccount, idempotencyKey: `${clientId}:${invoiceId}:finalize` }
          )
        ),
        { notFound: "Invoice not found.", generic: true }
      );
      if (!finalized) return reply;
      if (finalized instanceof Rejected) {
        return replyAfterRejection(
          deps,
          request,
          reply,
          row,
          "invoices.finalizeInvoice",
          ["draft"],
          finalized.err
        );
      }
      result = finalized;
    }

    const updated = await persistAfterStripe(request, reply, row, () =>
      applyStripeInvoice(db, row, result)
    );
    if (!updated) return reply;
    if (result.status !== "open") {
      return lifecycleErr(
        reply,
        409,
        "INVOICE_NOT_FINALIZABLE",
        `The invoice is ${result.status} and cannot be finalized.`
      );
    }
    return reply.code(200).send(serializeInvoice(updated));
  });

  // Allowed when charges are off: a client that lost its charges can still cancel what it sent.
  fastify.post(
    "/invoices/:id/void",
    { preHandler: lifecycleOpenGuards },
    async (request, reply) => {
      const params = invoiceIdParams(request, reply);
      if (!params) return;
      const clientId = (request as RequestWithClient).client.id;
      const row = await loadLifecycleRow(request, reply, params.id);
      if (!row) return reply;
      if (row.status === "void") return reply.code(200).send(serializeInvoice(row));
      if (row.status === "paid" || row.status === "deleted") {
        return lifecycleErr(
          reply,
          409,
          "INVOICE_NOT_VOIDABLE",
          `A ${row.status} invoice cannot be voided.`
        );
      }
      if (!(await takeWriteToken(request, reply))) return reply;
      if (!(await claimInvoice(deps, request, reply, row))) return reply;

      const stripeAccount = row.connectedAccountId;
      const invoiceId = row.stripeInvoiceId as string;
      const fresh = await stripeCall(
        request,
        reply,
        "invoices.retrieve",
        () => stripe.invoices.retrieve(invoiceId, {}, { stripeAccount }),
        { write: true, notFound: "Invoice not found.", generic: true }
      );
      if (!fresh) return reply;

      let result: Stripe.Invoice = fresh;
      if (fresh.status === "open" || fresh.status === "uncollectible") {
        const voided = await stripeCall(
          request,
          reply,
          "invoices.voidInvoice",
          rejectable(() =>
            stripe.invoices.voidInvoice(
              invoiceId,
              {},
              { stripeAccount, idempotencyKey: `${clientId}:${invoiceId}:void` }
            )
          ),
          { notFound: "Invoice not found." }
        );
        if (!voided) return reply;
        if (voided instanceof Rejected) {
          return replyAfterRejection(
            deps,
            request,
            reply,
            row,
            "invoices.voidInvoice",
            ["open", "uncollectible"],
            voided.err
          );
        }
        result = voided;
      }

      const updated = await persistAfterStripe(request, reply, row, () =>
        applyStripeInvoice(db, row, result)
      );
      if (!updated) return reply;
      if (result.status === "void") return reply.code(200).send(serializeInvoice(updated));
      return lifecycleErr(
        reply,
        409,
        "INVOICE_NOT_VOIDABLE",
        result.status === "draft"
          ? "A draft invoice cannot be voided; delete it with DELETE /invoices/:id."
          : `A ${result.status} invoice cannot be voided.`
      );
    }
  );

  // ── DELETE /invoices/:id ───────────────────────────────────────────────────
  // Drafts only. The row's claim is taken first, so a delete never races a create that is still
  // adding lines (or a finalize), and a create that comes back afterwards finds the row deleted.

  fastify.delete("/invoices/:id", { preHandler: lifecycleOpenGuards }, async (request, reply) => {
    const params = invoiceIdParams(request, reply);
    if (!params) return;
    const row = await loadLifecycleRow(request, reply, params.id);
    if (!row) return reply;
    if (row.status === "deleted") return reply.code(200).send(serializeInvoice(row));
    if (row.status !== "draft") {
      return lifecycleErr(
        reply,
        409,
        "INVOICE_NOT_DELETABLE",
        `Only draft invoices can be deleted; this one is ${row.status}. Use void for an open invoice.`
      );
    }
    if (!(await takeWriteToken(request, reply))) return reply;
    if (!(await claimInvoice(deps, request, reply, row, { draftOnly: true, deletedIsOk: true }))) {
      return reply;
    }

    const stripeAccount = row.connectedAccountId;
    const invoiceId = row.stripeInvoiceId as string;
    // A 404 from Stripe means the draft is already gone: that is the outcome the caller wants.
    let gone = false;
    const out = await stripeCall(
      request,
      reply,
      "invoices.del",
      rejectable(async () => {
        try {
          return await stripe.invoices.del(invoiceId, {}, { stripeAccount });
        } catch (err) {
          if (isResourceMissing(err)) {
            gone = true;
            return undefined;
          }
          throw err;
        }
      }),
      { write: true, generic: true }
    );
    if (out instanceof Rejected) {
      return replyAfterRejection(deps, request, reply, row, "invoices.del", ["draft"], out.err);
    }
    // `undefined` after a 404-as-success is not an error reply: told apart by `gone`.
    if (!gone && (out === undefined || reply.sent)) return reply;

    const updated = await persistAfterStripe(request, reply, row, async () => {
      const [u] = await db
        .update(connectInvoices)
        .set({ status: "deleted", claimedAt: null, lastSyncedAt: new Date() })
        .where(
          and(
            eq(connectInvoices.id, row.id),
            inArray(connectInvoices.status, [...INVOICE_STATUS_PRIORS.deleted])
          )
        )
        .returning();
      return u ?? row;
    });
    if (!updated) return reply;
    return reply.code(200).send(serializeInvoice(updated));
  });
}
