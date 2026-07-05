import crypto from "node:crypto";
import { count, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { clients, webhookEvents } from "../db/schema";
import { getCircuitBreakerStates } from "../lib/circuit-breakers";

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
  fastify.get("/metrics", async (request, reply) => {
    const metricsToken = process.env.METRICS_TOKEN;
    // Fail closed: if no token is configured the endpoint is disabled entirely
    // (returns 404) rather than being publicly readable.
    if (!metricsToken) {
      return reply.status(404).send({ error: "Not Found" });
    }
    if (!isAuthorizedForMetrics(request.headers.authorization, metricsToken)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const [clientCount] = await db.select({ count: count() }).from(clients);
    const [webhookCount] = await db.select({ count: count() }).from(webhookEvents);
    const [unprocessedWebhooks] = await db
      .select({ count: count() })
      .from(webhookEvents)
      .where(isNull(webhookEvents.processedAt));
    const circuits = getCircuitBreakerStates();

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
      `# HELP dfwsc_circuit_open Circuit breaker open state by service`,
      `# TYPE dfwsc_circuit_open gauge`,
      `dfwsc_circuit_open{service="stripe"} ${circuits.stripe.open ? 1 : 0}`,
      `dfwsc_circuit_open{service="smtp"} ${circuits.smtp.open ? 1 : 0}`,
      `# HELP dfwsc_circuit_half_open Circuit breaker half-open state by service`,
      `# TYPE dfwsc_circuit_half_open gauge`,
      `dfwsc_circuit_half_open{service="stripe"} ${circuits.stripe.halfOpen ? 1 : 0}`,
      `dfwsc_circuit_half_open{service="smtp"} ${circuits.smtp.halfOpen ? 1 : 0}`,
      `# HELP dfwsc_circuit_failures_total Circuit breaker failures by service`,
      `# TYPE dfwsc_circuit_failures_total counter`,
      `dfwsc_circuit_failures_total{service="stripe"} ${circuits.stripe.failures}`,
      `dfwsc_circuit_failures_total{service="smtp"} ${circuits.smtp.failures}`,
      `# HELP dfwsc_circuit_rejects_total Circuit breaker rejected calls by service`,
      `# TYPE dfwsc_circuit_rejects_total counter`,
      `dfwsc_circuit_rejects_total{service="stripe"} ${circuits.stripe.rejects}`,
      `dfwsc_circuit_rejects_total{service="smtp"} ${circuits.smtp.rejects}`,
    ].join("\n");

    return reply.type("text/plain").send(metrics);
  });
}
