import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";

interface ClientPatchBody {
  status?: "active" | "inactive";
  groupId?: string | null;
  paymentSuccessUrl?: string | null;
  paymentCancelUrl?: string | null;
  processingFeePercent?: number | null;
  processingFeeCents?: number | null;
}

interface ClientParams {
  id: string;
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

const clientRoutes: FastifyPluginAsync = async (app) => {
  app.get("/clients", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { groupId } = req.query as { groupId?: string };

      const query = db
        .select({
          id: clients.id,
          name: clients.name,
          email: clients.email,
          stripeAccountId: clients.stripeAccountId,
          status: clients.status,
          groupId: clients.groupId,
          processingFeePercent: clients.processingFeePercent,
          processingFeeCents: clients.processingFeeCents,
          createdAt: clients.createdAt,
        })
        .from(clients);

      const clientList = groupId ? await query.where(eq(clients.groupId, groupId)) : await query;

      return res.status(200).send(
        clientList.map((client) => ({
          ...client,
          createdAt: client.createdAt?.toISOString(),
        }))
      );
    } catch (error) {
      req.log.error(error, "Error fetching client list");
      return res.status(500).send({ error: "Internal server error" });
    }
  });

  app.patch<{
    Params: ClientParams;
    Body: ClientPatchBody;
  }>("/clients/:id", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { id } = req.params;
      const {
        status,
        groupId,
        paymentSuccessUrl,
        paymentCancelUrl,
        processingFeePercent,
        processingFeeCents,
      } = req.body;

      if (status !== undefined && status !== "active" && status !== "inactive") {
        return res.status(400).send({
          error: 'Invalid status value. Must be "active" or "inactive".',
        });
      }

      if (paymentSuccessUrl != null && !isValidHttpsUrl(paymentSuccessUrl)) {
        return res.status(400).send({ error: "paymentSuccessUrl must be a valid HTTPS URL." });
      }

      if (paymentCancelUrl != null && !isValidHttpsUrl(paymentCancelUrl)) {
        return res.status(400).send({ error: "paymentCancelUrl must be a valid HTTPS URL." });
      }

      if (processingFeePercent != null && processingFeeCents != null) {
        return res.status(400).send({ error: "Set one fee type, not both." });
      }

      if (
        processingFeePercent != null &&
        (processingFeePercent <= 0 || processingFeePercent > 100)
      ) {
        return res
          .status(400)
          .send({ error: "processingFeePercent must be greater than 0 and at most 100." });
      }

      if (
        processingFeeCents != null &&
        (!Number.isInteger(processingFeeCents) || processingFeeCents < 0)
      ) {
        return res
          .status(400)
          .send({ error: "processingFeeCents must be a non-negative integer." });
      }

      if (groupId != null) {
        const [group] = await db
          .select()
          .from(clientGroups)
          .where(eq(clientGroups.id, groupId))
          .limit(1);
        if (!group) {
          return res.status(400).send({ error: "Group not found." });
        }
      }

      const existingClient = await db.select().from(clients).where(eq(clients.id, id)).limit(1);

      if (existingClient.length === 0) {
        return res.status(404).send({ error: "Client not found." });
      }

      const setValues: {
        updatedAt: Date;
        status?: "active" | "inactive";
        groupId?: string | null;
        paymentSuccessUrl?: string | null;
        paymentCancelUrl?: string | null;
        processingFeePercent?: string | null;
        processingFeeCents?: number | null;
      } = { updatedAt: new Date() };

      if (status !== undefined) setValues.status = status;
      if ("groupId" in req.body) setValues.groupId = groupId;
      if ("paymentSuccessUrl" in req.body) setValues.paymentSuccessUrl = paymentSuccessUrl;
      if ("paymentCancelUrl" in req.body) setValues.paymentCancelUrl = paymentCancelUrl;
      if ("processingFeePercent" in req.body)
        setValues.processingFeePercent =
          processingFeePercent != null ? String(processingFeePercent) : null;
      if ("processingFeeCents" in req.body) setValues.processingFeeCents = processingFeeCents;

      const updatedClients = await db
        .update(clients)
        .set(setValues)
        .where(eq(clients.id, id))
        .returning();

      if (updatedClients.length === 0) {
        return res.status(500).send({ error: "Failed to update client." });
      }

      const updatedClient = updatedClients[0];
      return res.status(200).send({
        id: updatedClient.id,
        name: updatedClient.name,
        email: updatedClient.email,
        stripeAccountId: updatedClient.stripeAccountId,
        status: updatedClient.status,
        groupId: updatedClient.groupId,
        paymentSuccessUrl: updatedClient.paymentSuccessUrl,
        paymentCancelUrl: updatedClient.paymentCancelUrl,
        processingFeePercent: updatedClient.processingFeePercent,
        processingFeeCents: updatedClient.processingFeeCents,
        createdAt: updatedClient.createdAt?.toISOString(),
        updatedAt: updatedClient.updatedAt?.toISOString(),
      });
    } catch (error) {
      req.log.error(error, "Error updating client");
      return res.status(500).send({ error: "Internal server error" });
    }
  });
};

export default clientRoutes;
