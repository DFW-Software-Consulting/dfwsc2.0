import { eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { sendInvoiceEmail } from "../lib/mailer";
import { stripe } from "../lib/stripe";
import { ensureStripeCustomer, resolveClientFee } from "../lib/stripe-billing";
import { isWorkspace, type Workspace } from "../lib/workspace";

interface CreateInvoiceBody {
  clientId: string;
  workspace: Workspace;
  amountCents: number;
  description: string;
  dueDate?: string | null;
  waiveFee?: boolean;
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
      const { clientId, workspace, amountCents, description, dueDate, waiveFee = false } = req.body;

      if (!isWorkspace(workspace)) {
        return res
          .status(400)
          .send({ error: "workspace is required (dfwsc_services|client_portal)." });
      }

      if (!clientId) {
        return res.status(400).send({ error: "clientId is required." });
      }
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return res.status(400).send({ error: "amountCents must be a positive integer." });
      }
      if (!description || description.trim().length === 0) {
        return res.status(400).send({ error: "description is required." });
      }

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

      const daysUntilDue = dueDate
        ? Math.max(1, Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86_400_000))
        : 30;

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
        },
      });

      const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

      const totalChargedCents = waiveFee ? amountCents : amountCents + feeAmount;

      await sendInvoiceEmail({
        to: client.email,
        clientName: client.name,
        amountCents: totalChargedCents,
        description: description.trim(),
        dueDate: dueDate ? new Date(dueDate) : null,
        payUrl: finalized.hosted_invoice_url ?? "",
        isSubscription: false,
      }).catch(() => {});

      return res.status(201).send(formatStripeInvoice(finalized, clientId, client.name));
    }
  );

  // GET /invoices — list with optional ?clientId= and ?status= filters
  app.get<{ Querystring: InvoiceFilterQuery }>(
    "/invoices",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { workspace, clientId, status } = req.query;

      if (!isWorkspace(workspace)) {
        return res
          .status(400)
          .send({ error: "workspace query parameter is required (dfwsc_services|client_portal)." });
      }

      if (clientId) {
        const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
        if (!client?.stripeCustomerId || client.workspace !== workspace) {
          return res.status(200).send([]);
        }

        const listParams: Stripe.InvoiceListParams = {
          customer: client.stripeCustomerId,
          limit: 100,
        };
        if (status) listParams.status = status as Stripe.Invoice.Status;

        const list = await stripe.invoices.list(listParams);
        return res
          .status(200)
          .send(list.data.map((inv) => formatStripeInvoice(inv, clientId, client.name)));
      }

      const listParams: Stripe.InvoiceListParams = { limit: 100 };
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
};

export default invoiceRoutes;
