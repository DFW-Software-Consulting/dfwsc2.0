import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/client";
import { clients, invoices, subscriptions } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { sendInvoiceEmail } from "../lib/mailer";

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

function addBillingInterval(date: Date, interval: "monthly" | "quarterly" | "yearly"): Date {
  const next = new Date(date);
  if (interval === "monthly") {
    next.setMonth(next.getMonth() + 1);
  } else if (interval === "quarterly") {
    next.setMonth(next.getMonth() + 3);
  } else {
    next.setFullYear(next.getFullYear() + 1);
  }
  return next;
}

function formatSubscription(
  sub: typeof subscriptions.$inferSelect & { clientName?: string | null }
) {
  return {
    id: sub.id,
    clientId: sub.clientId,
    clientName: sub.clientName ?? null,
    amountCents: sub.amountCents,
    description: sub.description,
    interval: sub.interval,
    totalPayments: sub.totalPayments,
    paymentsMade: sub.paymentsMade,
    status: sub.status,
    nextBillingDate: sub.nextBillingDate?.toISOString() ?? null,
    createdAt: sub.createdAt?.toISOString() ?? null,
    updatedAt: sub.updatedAt?.toISOString() ?? null,
  };
}

function formatInvoice(inv: typeof invoices.$inferSelect) {
  return {
    id: inv.id,
    clientId: inv.clientId,
    subscriptionId: inv.subscriptionId,
    amountCents: inv.amountCents,
    description: inv.description,
    dueDate: inv.dueDate?.toISOString() ?? null,
    status: inv.status,
    paymentToken: inv.paymentToken,
    paidAt: inv.paidAt?.toISOString() ?? null,
    mockPaymentId: inv.mockPaymentId,
    createdAt: inv.createdAt?.toISOString() ?? null,
    updatedAt: inv.updatedAt?.toISOString() ?? null,
  };
}

const subscriptionRoutes: FastifyPluginAsync = async (app) => {
  // POST /subscriptions — create subscription + first invoice
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

      const now = new Date();
      const nextBillingDate = addBillingInterval(now, interval);
      const subId = crypto.randomUUID();

      await db.insert(subscriptions).values({
        id: subId,
        clientId,
        amountCents,
        description: description.trim(),
        interval,
        totalPayments: totalPayments ?? null,
        paymentsMade: 0,
        status: "active",
        nextBillingDate,
        createdAt: now,
        updatedAt: now,
      });

      const token = crypto.randomBytes(32).toString("hex");
      const invoiceId = crypto.randomUUID();

      await db.insert(invoices).values({
        id: invoiceId,
        clientId,
        subscriptionId: subId,
        amountCents,
        description: description.trim(),
        dueDate: nextBillingDate,
        status: "pending",
        paymentToken: token,
        createdAt: now,
        updatedAt: now,
      });

      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subId))
        .limit(1);

      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);

      const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "";
      const payUrl = `${frontendOrigin}/pay/${token}`;
      const paymentsRemaining = totalPayments ?? null;

      await sendInvoiceEmail({
        to: client.email,
        clientName: client.name,
        amountCents,
        description: description.trim(),
        dueDate: nextBillingDate,
        payUrl,
        isSubscription: true,
        paymentsRemaining,
      }).catch(() => {});

      return res.status(201).send({
        subscription: formatSubscription({ ...sub, clientName: client.name }),
        invoice: formatInvoice(invoice),
      });
    }
  );

  // GET /subscriptions — list with optional ?clientId= filter
  app.get<{ Querystring: SubscriptionFilterQuery }>(
    "/subscriptions",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { clientId } = req.query;

      const rows = await db
        .select({
          id: subscriptions.id,
          clientId: subscriptions.clientId,
          clientName: clients.name,
          amountCents: subscriptions.amountCents,
          description: subscriptions.description,
          interval: subscriptions.interval,
          totalPayments: subscriptions.totalPayments,
          paymentsMade: subscriptions.paymentsMade,
          status: subscriptions.status,
          nextBillingDate: subscriptions.nextBillingDate,
          createdAt: subscriptions.createdAt,
          updatedAt: subscriptions.updatedAt,
        })
        .from(subscriptions)
        .leftJoin(clients, eq(subscriptions.clientId, clients.id));

      const filtered = clientId ? rows.filter((r) => r.clientId === clientId) : rows;

      return res.status(200).send(
        filtered.map((r) =>
          formatSubscription({
            ...r,
            nextBillingDate: r.nextBillingDate ?? null,
            createdAt: r.createdAt ?? null,
            updatedAt: r.updatedAt ?? null,
          })
        )
      );
    }
  );

  // GET /subscriptions/:id — single subscription + invoice list
  app.get<{ Params: SubscriptionParams }>(
    "/subscriptions/:id",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;

      const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);

      if (!sub) {
        return res.status(404).send({ error: "Subscription not found." });
      }

      const [client] = await db.select().from(clients).where(eq(clients.id, sub.clientId)).limit(1);

      const subInvoices = await db.select().from(invoices).where(eq(invoices.subscriptionId, id));

      return res.status(200).send({
        ...formatSubscription({ ...sub, clientName: client?.name ?? null }),
        invoices: subInvoices.map(formatInvoice),
      });
    }
  );

  // PATCH /subscriptions/:id — pause, cancel, resume, or edit fields
  app.patch<{ Params: SubscriptionParams; Body: SubscriptionPatchBody }>(
    "/subscriptions/:id",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;
      const { status, totalPayments, amountCents, description } = req.body;

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

      if (amountCents !== undefined) {
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
          return res.status(422).send({ error: "amountCents must be a positive integer." });
        }
      }

      if (description !== undefined) {
        if (!description || description.trim().length === 0) {
          return res.status(422).send({ error: "description must not be blank." });
        }
      }

      const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);

      if (!sub) {
        return res.status(404).send({ error: "Subscription not found." });
      }

      if (sub.status === "completed") {
        return res.status(422).send({ error: "Cannot modify a completed subscription." });
      }

      if (status === "active" && sub.status === "cancelled") {
        return res.status(422).send({ error: "Cannot resume a cancelled subscription." });
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (status !== undefined) updates.status = status;
      if (totalPayments !== undefined) updates.totalPayments = totalPayments;
      if (amountCents !== undefined) updates.amountCents = amountCents;
      if (description !== undefined) updates.description = description.trim();

      await db.update(subscriptions).set(updates).where(eq(subscriptions.id, id));

      const [updated] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, id))
        .limit(1);

      return res.status(200).send(formatSubscription(updated));
    }
  );
};

export default subscriptionRoutes;
