import type { FastifyPluginAsync } from "fastify";
import { requireAdminJwt } from "../lib/auth";
import { createDfwscClient } from "../lib/nextcloud-contacts";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { eq, sql } from "drizzle-orm";

interface CreateClientBody {
  name: string;
  email: string;
  phone?: string;
  notes?: string;
}

const crmClientsRoute: FastifyPluginAsync = async (app) => {
  // POST /api/v1/crm/clients - Create a DFWSC client (saved to Nextcloud)
  app.post<{ Body: CreateClientBody }>(
    "/crm/clients",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { name, email, phone, notes } = req.body;

      if (!name || name.trim().length === 0) {
        return res.status(400).send({ error: "name is required" });
      }

      if (!email || email.trim().length === 0) {
        return res.status(400).send({ error: "email is required" });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).send({ error: "valid email is required" });
      }

      try {
        const [existing] = await db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(sql`lower(${clients.email})`, email.toLowerCase().trim()))
          .limit(1);

        if (existing) {
          return res.status(409).send({ error: "A client with this email already exists" });
        }

        const result = await createDfwscClient({
          name: name.trim(),
          email: email.trim(),
          phone: phone?.trim(),
          notes: notes?.trim(),
        });

        if (!result.synced && result.error) {
          app.log.warn({ error: result.error, clientId: result.clientId }, "Failed to sync client to Nextcloud");
        }

        const status = result.synced && result.stripeCustomerId ? "active" : result.synced ? "synced" : "local_only";

        return res.status(201).send({
          id: result.clientId,
          name: name.trim(),
          email: email.toLowerCase().trim(),
          workspace: "dfwsc",
          stripeCustomerId: result.stripeCustomerId,
          status,
          nextcloudId: result.externalId,
        });
      } catch (error) {
        req.log.error(error, "Error creating DFWSC client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  // GET /api/v1/crm/clients - List all DFWSC clients
  app.get(
    "/crm/clients",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const clientList = await db
          .select({
            id: clients.id,
            name: clients.name,
            email: clients.email,
            phone: clients.phone,
            notes: clients.notes,
            status: clients.status,
            createdAt: clients.createdAt,
          })
          .from(clients)
          .where(eq(clients.workspace, "dfwsc"));

        return res.status(200).send(
          clientList.map((c) => ({
            ...c,
            createdAt: c.createdAt?.toISOString(),
          }))
        );
      } catch (error) {
        req.log.error(error, "Error listing DFWSC clients");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default crmClientsRoute;