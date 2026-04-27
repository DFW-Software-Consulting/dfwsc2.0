import type { FastifyPluginAsync } from "fastify";
import { requireAdminJwt } from "../lib/auth";
import { createInvoiceForClient, getLedgerInvoicesForClient } from "../lib/nextcloud-invoices";
import { db } from "../db/client";
import { invoices, clients } from "../db/schema";
import { eq, desc, and, isNotNull } from "drizzle-orm";

interface CreateInvoiceBody {
  clientId: string;
  amountCents: number;
  invoiceNumber?: string;
  description?: string;
  dueDate?: string;
  notes?: string;
}

interface InvoiceParams {
  id: string;
}

const invoicesRoute: FastifyPluginAsync = async (app) => {
  // POST /api/v1/invoices - Create an invoice for a client
  app.post<{ Body: CreateInvoiceBody }>(
    "/invoices",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { clientId, amountCents, invoiceNumber, description, dueDate, notes } = req.body;

      if (!clientId) {
        return res.status(400).send({ error: "clientId is required" });
      }

      if (!amountCents || amountCents <= 0) {
        return res.status(400).send({ error: "amountCents must be a positive integer" });
      }

      const normalizedInvoiceNumber = invoiceNumber?.trim() || `INV-${Date.now()}`;

      try {
        const [client] = await db
          .select()
          .from(clients)
          .where(eq(clients.id, clientId))
          .limit(1);

        if (!client) {
          return res.status(404).send({ error: "Client not found" });
        }

        const result = await createInvoiceForClient(clientId, {
          amountCents,
          invoiceNumber: normalizedInvoiceNumber,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          notes: (notes || description)?.trim(),
        });

        if (result.error && !result.invoiceId) {
          return res.status(502).send({ error: result.error });
        }

        return res.status(201).send({
          id: result.invoiceId,
          clientId,
          invoiceNumber: normalizedInvoiceNumber,
          amountCents,
          status: "synced",
          nextcloudId: result.externalId,
        });
      } catch (error) {
        req.log.error(error, "Error creating invoice");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  app.get(
    "/invoices/ledger",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { clientId } = req.query as { clientId?: string };
        if (!clientId) {
          return res.status(400).send({ error: "clientId is required" });
        }

        const result = await getLedgerInvoicesForClient(clientId);
        if (result.error) {
          return res.status(502).send({ error: result.error });
        }

        return res.status(200).send(result.invoices);
      } catch (error) {
        req.log.error(error, "Error pulling invoices from Nextcloud Ledger");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  // GET /api/v1/invoices - List all invoices
  app.get(
    "/invoices",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { clientId, syncedOnly } = req.query as { clientId?: string; syncedOnly?: string };

        let query = db
          .select({
            id: invoices.id,
            clientId: invoices.clientId,
            invoiceNumber: invoices.invoiceNumber,
            amountCents: invoices.amountCents,
            status: invoices.status,
            dueDate: invoices.dueDate,
            paidAt: invoices.paidAt,
            stripeInvoiceId: invoices.stripeInvoiceId,
            nextcloudId: invoices.nextcloudId,
            notes: invoices.notes,
            createdAt: invoices.createdAt,
          })
          .from(invoices)
          .orderBy(desc(invoices.createdAt));

        let condition = clientId ? eq(invoices.clientId, clientId) : undefined;
        if (syncedOnly === "true") {
          condition = condition ? and(condition, isNotNull(invoices.nextcloudId)) : isNotNull(invoices.nextcloudId);
        }
        const invoiceList = condition ? await query.where(condition) : await query;

        const clientIds = [...new Set(invoiceList.map((i) => i.clientId))];
        const clientRows = clientIds.length > 0
          ? await db.select().from(clients).where(
            clientIds.length === 1 ? eq(clients.id, clientIds[0]) : undefined
          )
          : [];
        const clientMap = clientRows.length > 0
          ? new Map(clientRows.map((c) => [c.id, c]))
          : new Map();

        return res.status(200).send(
          invoiceList.map((inv) => {
            const client = clientMap.get(inv.clientId);
            return {
              ...inv,
              clientName: client?.name || "Unknown",
              dueDate: inv.dueDate?.toISOString(),
              paidAt: inv.paidAt?.toISOString(),
              createdAt: inv.createdAt?.toISOString(),
            };
          })
        );
      } catch (error) {
        req.log.error(error, "Error listing invoices");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  // POST /api/v1/invoices/:id/mark-paid-out-of-band
  app.post<{
    Params: InvoiceParams;
    Body: { notes?: string };
  }>("/invoices/:id/mark-paid-out-of-band", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { id } = req.params;
      const { notes } = req.body ?? {};

      const [existing] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, id))
        .limit(1);

      if (!existing) {
        return res.status(404).send({ error: "Invoice not found" });
      }

      const paidAt = new Date();
      await db
        .update(invoices)
        .set({ status: "paid", paidAt, updatedAt: paidAt, ...(notes ? { notes } : {}) })
        .where(eq(invoices.id, id));

      return res.status(200).send({ id, status: "paid", paidAt });
    } catch (error) {
      req.log.error(error, "Error marking invoice paid out of band");
      return res.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /api/v1/invoices/:id - Update invoice (mark paid, void, etc.)
  app.patch<{
    Params: InvoiceParams;
    Body: { status?: string };
  }>("/invoices/:id", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const [existing] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, id))
        .limit(1);

      if (!existing) {
        return res.status(404).send({ error: "Invoice not found" });
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };

      if (status) {
        updates.status = status;
        if (status === "paid") {
          updates.paidAt = new Date();
        }
      }

      await db.update(invoices).set(updates).where(eq(invoices.id, id));

      return res.status(200).send({ id, ...updates });
    } catch (error) {
      req.log.error(error, "Error updating invoice");
      return res.status(500).send({ error: "Internal server error" });
    }
  });
};

export default invoicesRoute;
