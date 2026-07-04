import crypto from "node:crypto";
import { count, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { clients, webhookEvents } from "../db/schema";

function isAuthorizedForMetrics(authHeader: string | undefined, token: string): boolean {
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }
  const provided = authHeader.slice("Bearer ".length);
  const providedBuf = Buffer.from(provided);
  const tokenBuf = Buffer.from(token);
  if (providedBuf.length !== tokenBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, tokenBuf);
}

export default async function metricsRoute(fastify: FastifyInstance) {
  // TODO: set METRICS_TOKEN in production
  fastify.get("/metrics", async (request, reply) => {
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken && !isAuthorizedForMetrics(request.headers.authorization, metricsToken)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const [clientCount] = await db.select({ count: count() }).from(clients);
    const [webhookCount] = await db.select({ count: count() }).from(webhookEvents);
    const [unprocessedWebhooks] = await db
      .select({ count: count() })
      .from(webhookEvents)
      .where(isNull(webhookEvents.processedAt));

    const metrics = [
      `# HELP dfwsc_clients_total Total number of clients`,
      `# TYPE dfwsc_clients_total gauge`,
      `dfwsc_clients_total ${clientCount.count}`,
      `# HELP dfwsc_webhooks_total Total webhook events received`,
      `# TYPE dfwsc_webhooks_total counter`,
      `dfwsc_webhooks_total ${webhookCount.count}`,
      `# HELP dfwsc_webhooks_unprocessed Unprocessed webhook events`,
      `# TYPE dfwsc_webhooks_unprocessed gauge`,
      `dfwsc_webhooks_unprocessed ${unprocessedWebhooks.count}`,
    ].join("\n");

    return reply.type("text/plain").send(metrics);
  });
}
