import crypto from "node:crypto";
import { count, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { clients, salesLeadSubmissions, webhookEvents } from "../db/schema";
import { getCircuitBreakerStates } from "../lib/circuit-breakers";
import { getNextcloudBreakerState } from "../lib/nextcloud";
import { getSalesLeadSyncStats } from "../lib/sales-lead-sync";

const SALES_LEAD_STATUSES = ["pending", "completed", "failed"] as const;

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
    const nextcloudCircuit = getNextcloudBreakerState();
    const salesLeadRows = await db
      .select({ status: salesLeadSubmissions.status, count: count() })
      .from(salesLeadSubmissions)
      .groupBy(salesLeadSubmissions.status);
    const salesLeadCounts = new Map(salesLeadRows.map((row) => [row.status, row.count]));
    const salesLeadStats = getSalesLeadSyncStats();

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
      `# HELP dfwsc_nextcloud_circuit_open Nextcloud circuit breaker open state`,
      `# TYPE dfwsc_nextcloud_circuit_open gauge`,
      `dfwsc_nextcloud_circuit_open ${nextcloudCircuit.open ? 1 : 0}`,
      `# HELP dfwsc_sales_lead_submissions Sales lead submissions by status`,
      `# TYPE dfwsc_sales_lead_submissions gauge`,
      ...SALES_LEAD_STATUSES.map(
        (status) =>
          `dfwsc_sales_lead_submissions{status="${status}"} ${salesLeadCounts.get(status) ?? 0}`
      ),
      `# HELP dfwsc_sales_lead_last_cycle_ok 1 if the last sales lead cycle succeeded, 0 if not`,
      `# TYPE dfwsc_sales_lead_last_cycle_ok gauge`,
      `dfwsc_sales_lead_last_cycle_ok ${salesLeadStats.lastCycleStatus === "ok" ? 1 : 0}`,
      `# HELP dfwsc_sales_lead_last_cycle_timestamp_seconds When the last sales lead cycle ran (0 if never)`,
      `# TYPE dfwsc_sales_lead_last_cycle_timestamp_seconds gauge`,
      `dfwsc_sales_lead_last_cycle_timestamp_seconds ${salesLeadStats.lastCycleAt ? Math.floor(salesLeadStats.lastCycleAt.getTime() / 1000) : 0}`,
    ].join("\n");

    return reply.type("text/plain").send(metrics);
  });
}
