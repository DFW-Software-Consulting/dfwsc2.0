import { eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { sendInvoiceEmail } from "../lib/mailer";
import { stripe } from "../lib/stripe";
import { ensureStripeCustomer, toStripeInterval } from "../lib/stripe-billing";

interface CreateSubscriptionBody {
  clientId: string;
  amountCents: number;
  description: string;
  interval: "monthly" | "quarterly" | "yearly";
  totalPayments?: number | null;
}

interface SubscriptionParams {
  id: string;
}

interface SubscriptionPatchBody {
  status?: "paused" | "cancelled" | "active";
  totalPayments?: number | null;
  amountCents?: number;
  description?: string;
}

interface SubscriptionFilterQuery {
  clientId?: string;
}

function formatStripeSub(sub: Stripe.Subscription, clientId: string, clientName?: string | null) {
  const item = sub.items.data[0];
  const rawStatus = sub.pause_collection ? "paused" : sub.status;
  // Normalize Stripe's 'canceled' to 'cancelled'
  const status = (rawStatus as string) === "canceled" ? "cancelled" : rawStatus;
  // current_period_end exists at runtime but may not be in all SDK type versions
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;

  return {
    id: sub.id,
    clientId,
    clientName: clientName ?? null,
    amountCents: item?.price?.unit_amount ?? 0,
    description: sub.metadata?.description ?? "",
    interval: sub.metadata?.interval ?? "monthly",
    totalPayments: sub.metadata?.totalPayments ? Number(sub.metadata.totalPayments) : null,
    status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    createdAt: new Date(sub.created * 1000).toISOString(),
  };
}

function formatStripeInvoice(inv: Stripe.Invoice, clientId?: string | null) {
  return {
    id: inv.id,
    clientId: clientId ?? inv.metadata?.clientId ?? null,
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

const subscriptionRoutes: FastifyPluginAsync = async (app) => {
  // POST /subscriptions — create Stripe subscription + send first invoice
  app.post<{ Body: CreateSubscriptionBody }>(
    "/subscriptions",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { clientId, amountCents, description, interval, totalPayments } = req.body;

      if (!clientId) {
        return res.status(400).send({ error: "clientId is required." });
      }
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return res.status(400).send({ error: "amountCents must be a positive integer." });
      }
      if (!description || description.trim().length === 0) {
        return res.status(400).send({ error: "description is required." });
      }
      if (!["monthly", "quarterly", "yearly"].includes(interval)) {
        return res
          .status(400)
          .send({ error: "interval must be one of: monthly, quarterly, yearly." });
      }
      if (
        totalPayments !== undefined &&
        totalPayments !== null &&
        (!Number.isInteger(totalPayments) || totalPayments <= 0)
      ) {
        return res.status(400).send({ error: "totalPayments must be a positive integer." });
      }

      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      if (!client) {
        return res.status(404).send({ error: "Client not found." });
      }

      const customerId = await ensureStripeCustomer(client);

      const price = await stripe.prices.create({
        unit_amount: amountCents,
        currency: "usd",
        recurring: toStripeInterval(interval),
        product_data: { name: description.trim() },
      });

      const subMetadata: Record<string, string> = {
        clientId,
        description: description.trim(),
        interval,
      };
      if (totalPayments != null) {
        subMetadata.totalPayments = String(totalPayments);
      }

      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: price.id }],
        collection_method: "send_invoice",
        days_until_due: 30,
        metadata: subMetadata,
      });

      // Finalize first invoice if it's a draft
      let firstInvoice: Stripe.Invoice | null = null;
      if (sub.latest_invoice) {
        const latestInvoiceId =
          typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice.id;
        let inv = await stripe.invoices.retrieve(latestInvoiceId);
        if (inv.status === "draft") {
          inv = await stripe.invoices.finalizeInvoice(inv.id);
        }
        firstInvoice = inv;
      }

      const hostedInvoiceUrl = firstInvoice?.hosted_invoice_url ?? null;

      await sendInvoiceEmail({
        to: client.email,
        clientName: client.name,
        amountCents,
        description: description.trim(),
        dueDate: null,
        payUrl: hostedInvoiceUrl ?? "",
        isSubscription: true,
        paymentsRemaining: totalPayments ?? null,
      }).catch(() => {});

      return res.status(201).send({
        subscription: formatStripeSub(sub, clientId, client.name),
        hostedInvoiceUrl,
      });
    }
  );

  // GET /subscriptions — list with optional ?clientId= filter
  app.get<{ Querystring: SubscriptionFilterQuery }>(
    "/subscriptions",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { clientId } = req.query;

      if (clientId) {
        const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
        if (!client?.stripeCustomerId) {
          return res.status(200).send([]);
        }

        const list = await stripe.subscriptions.list({
          customer: client.stripeCustomerId,
          limit: 100,
        });
        return res
          .status(200)
          .send(list.data.map((sub) => formatStripeSub(sub, clientId, client.name)));
      }

      const list = await stripe.subscriptions.list({ limit: 100 });

      const clientIds = [
        ...new Set(list.data.map((sub) => sub.metadata?.clientId).filter(Boolean) as string[]),
      ];

      const clientRows =
        clientIds.length > 0
          ? await db.select().from(clients).where(inArray(clients.id, clientIds))
          : [];

      const clientMap = new Map(clientRows.map((c) => [c.id, c.name]));

      return res.status(200).send(
        list.data.map((sub) => {
          const cid = sub.metadata?.clientId ?? "";
          return formatStripeSub(sub, cid, clientMap.get(cid) ?? null);
        })
      );
    }
  );

  // GET /subscriptions/:id — single subscription + invoice list
  app.get<{ Params: SubscriptionParams }>(
    "/subscriptions/:id",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;

      let sub: Stripe.Subscription;
      try {
        sub = await stripe.subscriptions.retrieve(id, {
          expand: ["latest_invoice", "items.data.price"],
        });
      } catch {
        return res.status(404).send({ error: "Subscription not found." });
      }

      const clientId = sub.metadata?.clientId ?? "";

      let clientName: string | null = null;
      if (clientId) {
        const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
        clientName = client?.name ?? null;
      }

      const invoiceList = await stripe.invoices.list({ subscription: id, limit: 100 });

      return res.status(200).send({
        ...formatStripeSub(sub, clientId, clientName),
        invoices: invoiceList.data.map((inv) => formatStripeInvoice(inv, clientId)),
      });
    }
  );

  // PATCH /subscriptions/:id — pause, cancel, resume, or update totalPayments
  app.patch<{ Params: SubscriptionParams; Body: SubscriptionPatchBody }>(
    "/subscriptions/:id",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;
      const { status, totalPayments, amountCents, description } = req.body;

      if (amountCents !== undefined || description !== undefined) {
        return res.status(400).send({
          error:
            "Editing amountCents and description is not supported. Only totalPayments and status can be changed.",
        });
      }

      if (status !== undefined) {
        const ALLOWED_STATUSES = ["paused", "cancelled", "active"];
        if (!ALLOWED_STATUSES.includes(status)) {
          return res
            .status(422)
            .send({ error: "status must be one of: paused, cancelled, active." });
        }
      }

      if (totalPayments !== undefined && totalPayments !== null) {
        if (!Number.isInteger(totalPayments) || totalPayments < 1) {
          return res.status(422).send({ error: "totalPayments must be a positive integer." });
        }
      }

      let sub: Stripe.Subscription;
      try {
        sub = await stripe.subscriptions.retrieve(id);
      } catch {
        return res.status(404).send({ error: "Subscription not found." });
      }

      if ((sub.status as string) === "canceled") {
        return res.status(422).send({ error: "Cannot modify a cancelled subscription." });
      }

      if (status === "active" && (sub.status as string) === "canceled") {
        return res.status(422).send({ error: "Cannot resume a cancelled subscription." });
      }

      let updated = sub;

      if (status === "paused") {
        updated = await stripe.subscriptions.update(id, {
          pause_collection: { behavior: "void" },
        });
      } else if (status === "active") {
        // Pass "" to clear pause_collection (Stripe Emptyable field)
        // biome-ignore lint/suspicious/noExplicitAny: Stripe SDK requires "" to clear Emptyable fields
        updated = await stripe.subscriptions.update(id, { pause_collection: "" as any });
      } else if (status === "cancelled") {
        updated = await stripe.subscriptions.update(id, { cancel_at_period_end: true });
      }

      if (totalPayments !== undefined) {
        updated = await stripe.subscriptions.update(id, {
          metadata: {
            ...updated.metadata,
            totalPayments: totalPayments !== null ? String(totalPayments) : "",
          },
        });
      }

      const clientId = updated.metadata?.clientId ?? "";
      return res.status(200).send(formatStripeSub(updated, clientId));
    }
  );
};

export default subscriptionRoutes;
