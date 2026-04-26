import type { FastifyPluginAsync } from "fastify";
import { isValidNextcloudWebhook, upsertClientFromNextcloudWebhook } from "../lib/nextcloud-sync";

const integrationRoutes: FastifyPluginAsync = async (app) => {
  app.post<{
    Body: { eventId?: string; type?: string; data?: Record<string, unknown> };
  }>(
    "/integrations/nextcloud/webhook",
    {
      config: {
        rawBody: true,
      },
    },
    async (req, res) => {
      const secret = req.headers["x-nextcloud-webhooks"];
      const provided = Array.isArray(secret) ? secret[0] : secret;
      const rawBody =
        typeof req.rawBody === "string"
          ? req.rawBody
          : Buffer.isBuffer(req.rawBody)
            ? req.rawBody.toString("utf8")
            : JSON.stringify(req.body);

      if (!isValidNextcloudWebhook(provided, rawBody)) {
        return res.status(401).send({ error: "Invalid Nextcloud webhook signature." });
      }

      const rawData = req.body?.data ?? req.body;
      const data = rawData as Record<string, unknown>;
      try {
        await upsertClientFromNextcloudWebhook({
          workspace: typeof data.workspace === "string" ? data.workspace : undefined,
          externalId: typeof data.externalId === "string" ? data.externalId : undefined,
          companyName: typeof data.companyName === "string" ? data.companyName : undefined,
          contactName: typeof data.contactName === "string" ? data.contactName : undefined,
          contactEmail: typeof data.contactEmail === "string" ? data.contactEmail : undefined,
          status:
            data.status === "lead" || data.status === "client" || data.status === "inactive"
              ? data.status
              : undefined,
          phone: typeof data.phone === "string" ? data.phone : null,
          notes: typeof data.notes === "string" ? data.notes : null,
        });
        return res.status(200).send({ ok: true });
      } catch (error) {
        req.log.error(error, "Failed processing Nextcloud webhook.");
        return res
          .status(400)
          .send({ error: error instanceof Error ? error.message : "Webhook failed" });
      }
    }
  );
};

export default integrationRoutes;
