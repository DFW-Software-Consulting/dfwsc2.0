import { and, asc, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../../db/client";
import { connectInvoices } from "../../db/schema";
import { getCircuitBreakerStates } from "../../lib/circuit-breakers";
import {
  decodeCursor,
  encodeCursor,
  type InvoiceRow,
  listQuerySchema,
  serializeInvoice,
  TERMINAL_INVOICE_STATUSES,
} from "../../lib/connect-invoice";
import { applyStripeInvoice } from "../../lib/connect-invoice-sync";
import { INVOICE_RECONCILE_MIN_AGE_MS } from "../../lib/constants";
import { errors } from "../../lib/errors";
import { stripe } from "../../lib/stripe";
import { parseBody } from "../../lib/validation";
import {
  INVOICE_NOT_FOUND,
  type InvoicingDeps,
  idParamsSchema,
  type RequestWithClient,
} from "./shared";

/** Invoice reads: one by Stripe id (with a stale re-check), and the keyset-paged list. */
export function registerInvoiceReadRoutes(fastify: FastifyInstance, deps: InvoicingDeps) {
  const { readGuards } = deps;

  // Rows a caller may see: finished ones, and deleted drafts (even an orphan deleted before it
  // finished creating). Anything else is still being created.
  const visibleInvoice = or(
    eq(connectInvoices.creationState, "complete"),
    eq(connectInvoices.status, "deleted")
  );

  // ── Stale re-check (GET /invoices/:id) ─────────────────────────────────────
  // At most one Stripe lookup per invoice per interval and a bounded map, in process (the same
  // shape as the payments status reconcile).
  const lastInvoiceReconcile = new Map<string, number>();
  const RECONCILE_MAX_TRACKED = 1000;
  const RECONCILE_STRIPE_TIMEOUT_MS = 3000;

  function shouldAttemptInvoiceReconcile(key: string, now: number): boolean {
    const last = lastInvoiceReconcile.get(key);
    if (last !== undefined && now - last < INVOICE_RECONCILE_MIN_AGE_MS) return false;
    if (lastInvoiceReconcile.size >= RECONCILE_MAX_TRACKED) {
      for (const [k, at] of lastInvoiceReconcile) {
        if (now - at >= INVOICE_RECONCILE_MIN_AGE_MS) lastInvoiceReconcile.delete(k);
      }
      if (lastInvoiceReconcile.size >= RECONCILE_MAX_TRACKED) {
        const oldest = lastInvoiceReconcile.keys().next().value;
        if (oldest !== undefined) lastInvoiceReconcile.delete(oldest);
      }
    }
    lastInvoiceReconcile.set(key, now);
    return true;
  }

  /** Returns the row to report: refreshed from Stripe when stale, else as stored. Never throws. */
  async function reconcileStaleInvoice(
    row: InvoiceRow,
    request: FastifyRequest
  ): Promise<InvoiceRow> {
    const invoiceId = row.stripeInvoiceId;
    const now = Date.now();
    if (!invoiceId || (TERMINAL_INVOICE_STATUSES as readonly string[]).includes(row.status)) {
      return row;
    }
    const syncedAt = (row.lastSyncedAt ?? row.createdAt).getTime();
    if (now - syncedAt < INVOICE_RECONCILE_MIN_AGE_MS) return row;
    // Best effort on a read endpoint: honour an open breaker, but run the lookup outside it so
    // its failures do not count towards the breaker that guards invoice writes.
    if (getCircuitBreakerStates().stripe.open) return row;
    if (!shouldAttemptInvoiceReconcile(`${row.connectedAccountId}:${invoiceId}`, now)) return row;

    try {
      const invoice = await stripe.invoices.retrieve(
        invoiceId,
        {},
        {
          stripeAccount: row.connectedAccountId,
          timeout: RECONCILE_STRIPE_TIMEOUT_MS,
          maxNetworkRetries: 0,
        }
      );
      return await applyStripeInvoice(db, row, invoice);
    } catch (err) {
      // Codes only: a Stripe error message may quote customer data.
      request.log.warn(
        {
          clientId: row.clientId,
          stripeInvoiceId: invoiceId,
          stripeCode: (err as { code?: unknown } | null)?.code,
        },
        "Invoice status re-check with Stripe failed"
      );
      return row;
    }
  }

  // ── GET /invoices/:id ──────────────────────────────────────────────────────
  fastify.get("/invoices/:id", { preHandler: readGuards }, async (request, reply) => {
    const params = parseBody(idParamsSchema, request.params, reply);
    if (!params) return;
    const [row] = await db
      .select()
      .from(connectInvoices)
      .where(
        and(
          eq(connectInvoices.clientId, (request as RequestWithClient).client.id),
          eq(connectInvoices.stripeInvoiceId, params.id),
          visibleInvoice
        )
      )
      .limit(1);
    if (!row) return reply.code(404).send(INVOICE_NOT_FOUND);
    return reply.code(200).send(serializeInvoice(await reconcileStaleInvoice(row, request)));
  });

  // ── GET /invoices ──────────────────────────────────────────────────────────
  // Postgres only, newest first, keyset-paged on (created_at desc, id asc).
  fastify.get("/invoices", { preHandler: readGuards }, async (request, reply) => {
    const query = parseBody(listQuerySchema, request.query, reply);
    if (!query) return;
    let after: { createdAt: Date; id: string } | null = null;
    if (query.cursor) {
      after = decodeCursor(query.cursor);
      if (!after) throw errors.badRequest("cursor is invalid.");
    }
    const rows = await db
      .select()
      .from(connectInvoices)
      .where(
        and(
          eq(connectInvoices.clientId, (request as RequestWithClient).client.id),
          visibleInvoice,
          // Deleted drafts are listed only when asked for.
          query.status
            ? eq(connectInvoices.status, query.status)
            : ne(connectInvoices.status, "deleted"),
          query.customerId ? eq(connectInvoices.stripeCustomerId, query.customerId) : undefined,
          after
            ? or(
                lt(connectInvoices.createdAt, after.createdAt),
                and(
                  eq(connectInvoices.createdAt, after.createdAt),
                  sql`${connectInvoices.id} > ${after.id}`
                )
              )
            : undefined
        )
      )
      .orderBy(desc(connectInvoices.createdAt), asc(connectInvoices.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return reply.code(200).send({
      data: page.map(serializeInvoice),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    });
  });
}
