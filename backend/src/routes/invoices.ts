import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/client";
import { clients, invoices, subscriptions } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { sendInvoiceEmail } from "../lib/mailer";

interface CreateInvoiceBody {
  clientId: string;
  amountCents: number;
  description: string;
  dueDate?: string | null;
}

interface InvoiceParams {
  id: string;
}

interface PayTokenParams {
  token: string;
}

interface InvoiceFilterQuery {
  clientId?: string;
  status?: string;
}

function formatInvoice(inv: typeof invoices.$inferSelect & { clientName?: string | null }) {
  return {
    id: inv.id,
    clientId: inv.clientId,
    clientName: inv.clientName ?? null,
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

async function triggerAutoAdvance(subscriptionId: string): Promise<void> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);

  if (!sub || sub.status !== "active") return;

  const [client] = await db.select().from(clients).where(eq(clients.id, sub.clientId)).limit(1);
  if (!client) return;

  const newPaymentsMade = (sub.paymentsMade ?? 0) + 1;

  if (sub.totalPayments !== null && newPaymentsMade >= sub.totalPayments) {
    await db
      .update(subscriptions)
      .set({ paymentsMade: newPaymentsMade, status: "completed", updatedAt: new Date() })
      .where(eq(subscriptions.id, subscriptionId));
    return;
  }

  const nextBillingDate = addBillingInterval(
    sub.nextBillingDate ?? new Date(),
    sub.interval as "monthly" | "quarterly" | "yearly"
  );

  await db
    .update(subscriptions)
    .set({ paymentsMade: newPaymentsMade, nextBillingDate, updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId));

  const newToken = crypto.randomBytes(32).toString("hex");
  const newInvoiceId = crypto.randomUUID();
  const now = new Date();

  await db.insert(invoices).values({
    id: newInvoiceId,
    clientId: sub.clientId,
    subscriptionId: sub.id,
    amountCents: sub.amountCents,
    description: sub.description,
    dueDate: nextBillingDate,
    status: "pending",
    paymentToken: newToken,
    createdAt: now,
    updatedAt: now,
  });

  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "";
  const payUrl = `${frontendOrigin}/pay/${newToken}`;
  const paymentsRemaining = sub.totalPayments !== null ? sub.totalPayments - newPaymentsMade : null;

  await sendInvoiceEmail({
    to: client.email,
    clientName: client.name,
    amountCents: sub.amountCents,
    description: sub.description,
    dueDate: nextBillingDate,
    payUrl,
    isSubscription: true,
    paymentsRemaining,
  }).catch(() => {});
}

const invoiceRoutes: FastifyPluginAsync = async (app) => {
  // POST /invoices — create one-time invoice
  app.post<{ Body: CreateInvoiceBody }>(
    "/invoices",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { clientId, amountCents, description, dueDate } = req.body;

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

      const token = crypto.randomBytes(32).toString("hex");
      const id = crypto.randomUUID();
      const now = new Date();
      const parsedDueDate = dueDate ? new Date(dueDate) : null;

      await db.insert(invoices).values({
        id,
        clientId,
        subscriptionId: null,
        amountCents,
        description: description.trim(),
        dueDate: parsedDueDate,
        status: "pending",
        paymentToken: token,
        createdAt: now,
        updatedAt: now,
      });

      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);

      const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "";
      const payUrl = `${frontendOrigin}/pay/${token}`;

      await sendInvoiceEmail({
        to: client.email,
        clientName: client.name,
        amountCents,
        description: description.trim(),
        dueDate: parsedDueDate,
        payUrl,
        isSubscription: false,
      }).catch(() => {});

      return res.status(201).send(formatInvoice({ ...invoice, clientName: client.name }));
    }
  );

  // GET /invoices — list with optional ?clientId= and ?status= filters
  app.get<{ Querystring: InvoiceFilterQuery }>(
    "/invoices",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { clientId, status } = req.query;

      const rows = await db
        .select({
          id: invoices.id,
          clientId: invoices.clientId,
          clientName: clients.name,
          subscriptionId: invoices.subscriptionId,
          amountCents: invoices.amountCents,
          description: invoices.description,
          dueDate: invoices.dueDate,
          status: invoices.status,
          paymentToken: invoices.paymentToken,
          paidAt: invoices.paidAt,
          mockPaymentId: invoices.mockPaymentId,
          createdAt: invoices.createdAt,
          updatedAt: invoices.updatedAt,
        })
        .from(invoices)
        .leftJoin(clients, eq(invoices.clientId, clients.id));

      const filtered = rows.filter((r) => {
        if (clientId && r.clientId !== clientId) return false;
        if (status && r.status !== status) return false;
        return true;
      });

      return res.status(200).send(
        filtered.map((r) =>
          formatInvoice({
            ...r,
            dueDate: r.dueDate ?? null,
            paidAt: r.paidAt ?? null,
            mockPaymentId: r.mockPaymentId ?? null,
            subscriptionId: r.subscriptionId ?? null,
            createdAt: r.createdAt ?? null,
            updatedAt: r.updatedAt ?? null,
          })
        )
      );
    }
  );

  // GET /invoices/pay/:token — public, fetch invoice for payment page
  // MUST be registered before /invoices/:id to avoid route conflict
  app.get<{ Params: PayTokenParams }>("/invoices/pay/:token", async (req, res) => {
    const { token } = req.params;

    const [row] = await db
      .select({
        id: invoices.id,
        amountCents: invoices.amountCents,
        description: invoices.description,
        dueDate: invoices.dueDate,
        status: invoices.status,
        clientName: clients.name,
      })
      .from(invoices)
      .leftJoin(clients, eq(invoices.clientId, clients.id))
      .where(eq(invoices.paymentToken, token))
      .limit(1);

    if (!row) {
      return res.status(404).send({ error: "Invoice not found." });
    }

    return res.status(200).send({
      id: row.id,
      amountCents: row.amountCents,
      description: row.description,
      dueDate: row.dueDate?.toISOString() ?? null,
      status: row.status,
      clientName: row.clientName,
    });
  });

  // POST /invoices/pay/:token — public, process mock payment
  app.post<{ Params: PayTokenParams }>("/invoices/pay/:token", async (req, res) => {
    const { token } = req.params;

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.paymentToken, token))
      .limit(1);

    if (!invoice) {
      return res.status(404).send({ error: "Invoice not found." });
    }

    if (invoice.status === "cancelled") {
      return res.status(422).send({ error: "Invoice has been cancelled." });
    }

    if (invoice.status === "paid") {
      return res.status(409).send({ error: "Invoice has already been paid." });
    }

    const now = new Date();
    const mockPaymentId = `mock_pi_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const [updatedInvoice] = await db
      .update(invoices)
      .set({ status: "paid", paidAt: now, mockPaymentId, updatedAt: now })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.status, "pending")))
      .returning();

    if (!updatedInvoice) {
      return res.status(409).send({ error: "Invoice has already been paid." });
    }

    const payment = {
      id: mockPaymentId,
      status: "succeeded",
      amount: invoice.amountCents,
      currency: "usd",
      payment_method: "mock_pm_card_visa",
      created: Math.floor(now.getTime() / 1000),
      mock: true,
    };

    if (invoice.subscriptionId) {
      await triggerAutoAdvance(invoice.subscriptionId);
    }

    return res.status(200).send({
      invoice: formatInvoice(updatedInvoice),
      payment,
    });
  });

  // PATCH /invoices/:id — admin JWT, cancel pending invoice only
  app.patch<{ Params: InvoiceParams }>(
    "/invoices/:id",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;

      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);

      if (!invoice) {
        return res.status(404).send({ error: "Invoice not found." });
      }

      if (invoice.status !== "pending") {
        return res.status(422).send({ error: "Only pending invoices can be cancelled." });
      }

      await db
        .update(invoices)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(invoices.id, id));

      const [updated] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
      return res.status(200).send(formatInvoice(updated));
    }
  );
};

export default invoiceRoutes;
