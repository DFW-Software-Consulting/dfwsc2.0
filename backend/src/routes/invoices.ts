import { eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { sendInvoiceEmail } from "../lib/mailer";
import { stripe } from "../lib/stripe";
import { ensureStripeCustomer, resolveClientFee } from "../lib/stripe-billing";
import {
  calculateDaysUntilDue,
  STRIPE_LIST_LIMIT,
  validateAmountCents,
  validateRequiredString,
  validateTaxRate,
  validateWorkspace,
  type Workspace,
} from "../lib/validation";
import { appendLedgerRow, backfillLedger, updateLedgerRow, type LedgerRow } from "../lib/nextcloud-ledger";

interface CreateInvoiceBody {
  clientId: string;
  workspace: Workspace;
  amountCents: number;
  description: string;
  dueDate?: string | null;
  waiveFee?: boolean;
  taxRateId?: string | null;
}

interface InvoiceParams {
  id: string;
}

interface InvoiceFilterQuery {
  workspace?: string;
  clientId?: string;
  status?: string;
}

function formatStripeInvoice(
  inv: Stripe.Invoice,
  clientId?: string | null,
  clientName?: string | null
) {
  return {
    id: inv.id,
    clientId: clientId ?? inv.metadata?.clientId ?? null,
    clientName: clientName ?? null,
    amountCents: inv.amount_due,
    description: inv.description ?? "",
    dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
    status: inv.status,
    hostedUrl: inv.hosted_invoice_url ?? null,
    paidAt: inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
      : null,
    createdAt: new Date(inv.created * 1000).toISOString(),
  };
}

const invoiceRoutes: FastifyPluginAsync = async (app) => {
  // POST /invoices — create one-time Stripe invoice
  app.post<{ Body: CreateInvoiceBody }>(
    "/invoices",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const {
        clientId,
        workspace,
        amountCents,
        description,
        dueDate,
        waiveFee = false,
        taxRateId,
      } = req.body;

      const validWorkspace = validateWorkspace(workspace, res);
      if (!validWorkspace) return;

      if (!clientId) {
        return res.status(400).send({ error: "clientId is required." });
      }
      if (!validateAmountCents(amountCents, res)) return;
      if (!validateRequiredString(description, "description", res)) return;

      if (taxRateId && !(await validateTaxRate(taxRateId, res))) return;

      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      if (!client) {
        return res.status(404).send({ error: "Client not found." });
      }
      if (client.workspace !== workspace) {
        return res
          .status(400)
          .send({ error: "clientId does not belong to the selected workspace." });
      }

      const group = client.groupId
        ? ((
            await db.select().from(clientGroups).where(eq(clientGroups.id, client.groupId)).limit(1)
          )[0] ?? null)
        : null;

      let feeAmount: number;
      try {
        feeAmount = await resolveClientFee(client, group, amountCents);
      } catch (e: unknown) {
        return res.status(400).send({ error: (e as Error).message });
      }

      const customerId = await ensureStripeCustomer(client);

      const daysUntilDue = calculateDaysUntilDue(dueDate);

      // Base amount line item
      await stripe.invoiceItems.create({
        customer: customerId,
        amount: amountCents,
        currency: "usd",
        description: description.trim(),
      });

      // Fee line item (Actual or Waived)
      if (feeAmount > 0) {
        await stripe.invoiceItems.create({
          customer: customerId,
          amount: waiveFee ? 0 : feeAmount,
          currency: "usd",
          description: waiveFee ? "Processing Fee (Waived)" : "Processing Fee",
        });
      }

      const invoice = await stripe.invoices.create({
        customer: customerId,
        collection_method: "send_invoice",
        days_until_due: daysUntilDue,
        metadata: {
          clientId,
          baseAmount: amountCents.toString(),
          feeAmount: waiveFee ? "0" : feeAmount.toString(),
          waivedFeeAmount: waiveFee ? feeAmount.toString() : "0",
          taxRateId: taxRateId ?? "",
        },
        ...(taxRateId
          ? {
              default_tax_rates: [taxRateId],
            }
          : {}),
      });

      const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

      await sendInvoiceEmail({
        to: client.email,
        clientName: client.name,
        amountCents: finalized.amount_due,
        description: description.trim(),
        dueDate: dueDate ? new Date(dueDate) : null,
        payUrl: finalized.hosted_invoice_url ?? "",
        isSubscription: false,
      }).catch((err) => {
        req.log.warn({ err, clientId, invoiceId: finalized.id }, "Failed to send invoice email");
      });

      const formatted = formatStripeInvoice(finalized, clientId, client.name);

      // Fire-and-forget — ledger write should never block the response
      appendLedgerRow({
        date: new Date().toISOString().split("T")[0],
        client: client.name,
        invoiceId: finalized.id,
        description: description.trim(),
        amountCents,
        feeCents: waiveFee ? 0 : feeAmount,
        totalCents: finalized.amount_due,
        status: finalized.status ?? "open",
        dueDate: dueDate ?? null,
        paidAt: null,
      }).catch((err) => req.log.warn({ err }, "Nextcloud ledger append failed"));

      return res.status(201).send(formatted);
    }
  );

  // GET /invoices — list with optional ?clientId= and ?status= filters
  app.get<{ Querystring: InvoiceFilterQuery }>(
    "/invoices",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { workspace, clientId, status } = req.query;

      const validWorkspace = validateWorkspace(workspace, res);
      if (!validWorkspace) return;

      if (clientId) {
        const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
        if (!client?.stripeCustomerId || client.workspace !== workspace) {
          return res.status(200).send([]);
        }

        const listParams: Stripe.InvoiceListParams = {
          customer: client.stripeCustomerId,
          limit: STRIPE_LIST_LIMIT,
        };
        if (status) listParams.status = status as Stripe.Invoice.Status;

        const list = await stripe.invoices.list(listParams);
        return res
          .status(200)
          .send(list.data.map((inv) => formatStripeInvoice(inv, clientId, client.name)));
      }

      const listParams: Stripe.InvoiceListParams = { limit: STRIPE_LIST_LIMIT };
      if (status) listParams.status = status as Stripe.Invoice.Status;

      const list = await stripe.invoices.list(listParams);

      // Collect unique clientIds from metadata for bulk name lookup
      const clientIds = [
        ...new Set(list.data.map((inv) => inv.metadata?.clientId).filter(Boolean) as string[]),
      ];

      const clientRows =
        clientIds.length > 0
          ? await db.select().from(clients).where(inArray(clients.id, clientIds))
          : [];

      const scopedClients = clientRows.filter((c) => c.workspace === workspace);
      const clientMap = new Map(scopedClients.map((c) => [c.id, c.name]));

      return res.status(200).send(
        list.data
          .map((inv) => {
            const cid = inv.metadata?.clientId ?? null;
            if (!cid || !clientMap.has(cid)) return null;
            return formatStripeInvoice(inv, cid, clientMap.get(cid) ?? null);
          })
          .filter((entry): entry is ReturnType<typeof formatStripeInvoice> => entry !== null)
      );
    }
  );

  // PATCH /invoices/:id — admin JWT, void open or delete draft invoice
  app.patch<{ Params: InvoiceParams }>(
    "/invoices/:id",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;

      let invoice: Stripe.Invoice;
      try {
        invoice = await stripe.invoices.retrieve(id);
      } catch {
        return res.status(404).send({ error: "Invoice not found." });
      }

      if (invoice.status === "open") {
        const voided = await stripe.invoices.voidInvoice(id);
        updateLedgerRow(id, "void").catch((err) =>
          req.log.warn({ err }, "Nextcloud ledger update failed")
        );
        return res.status(200).send(formatStripeInvoice(voided));
      }

      if (invoice.status === "draft") {
        await stripe.invoices.del(id);
        return res.status(200).send({ id, status: "deleted" });
      }

      return res.status(422).send({
        error: `Invoice cannot be cancelled (status: ${invoice.status}).`,
      });
    }
  );
  // POST /invoices/backfill-ledger — one-time seed of Nextcloud ledger from all existing Stripe invoices
  app.post("/invoices/backfill-ledger", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      // Get all dfwsc_services clients that have a Stripe customer
      const dfwscClients = await db
        .select({ id: clients.id, name: clients.name, stripeCustomerId: clients.stripeCustomerId })
        .from(clients)
        .where(eq(clients.workspace, "dfwsc_services"));

      const clientByCustomerId = new Map(
        dfwscClients
          .filter((c) => c.stripeCustomerId)
          .map((c) => [c.stripeCustomerId!, { id: c.id, name: c.name }])
      );

      // Paginate through all Stripe invoices
      const allInvoices: Stripe.Invoice[] = [];
      let startingAfter: string | undefined;
      while (true) {
        const page = await stripe.invoices.list({ limit: 100, starting_after: startingAfter });
        allInvoices.push(...page.data);
        if (!page.has_more || page.data.length === 0) break;
        startingAfter = page.data[page.data.length - 1]?.id;
        if (!startingAfter) break;
      }

      // Map to ledger rows — only include invoices belonging to dfwsc_services clients
      const rows: LedgerRow[] = [];
      for (const inv of allInvoices) {
        const custId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        if (!custId) continue;
        const client = clientByCustomerId.get(custId);
        if (!client) continue;

        const baseAmount = inv.metadata?.baseAmount ? parseInt(inv.metadata.baseAmount, 10) : inv.amount_due;
        const feeAmount = inv.metadata?.feeAmount ? parseInt(inv.metadata.feeAmount, 10) : 0;

        rows.push({
          date: new Date(inv.created * 1000).toISOString().split("T")[0],
          client: client.name,
          invoiceId: inv.id,
          description: inv.description ?? "",
          amountCents: baseAmount,
          feeCents: feeAmount,
          totalCents: inv.amount_due,
          status: inv.status ?? "unknown",
          dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
          paidAt: inv.status_transitions?.paid_at
            ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
            : null,
        });
      }

      // Sort oldest first
      rows.sort((a, b) => a.date.localeCompare(b.date));

      const count = await backfillLedger(rows);
      return res.status(200).send({ backfilled: count });
    } catch (err) {
      req.log.error(err, "Ledger backfill failed");
      return res.status(500).send({ error: "Ledger backfill failed." });
    }
  });
};

export default invoiceRoutes;
