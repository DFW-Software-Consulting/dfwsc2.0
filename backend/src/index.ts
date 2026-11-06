import path from "node:path";
import dotenv from "dotenv";
import { errorLogFields } from "./lib/safe-error-log";

// Load environment variables synchronously before any other imports
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
}

// Now import and start the server after env vars are loaded
async function start() {
  const { buildServer } = await import("./app");
  const { runMigrations } = await import("./lib/migrate");
  const { verifyDatabaseSchema } = await import("./lib/schema-check");
  const { pruneProcessedWebhookEvents } = await import("./lib/webhook-retention");
  const { WEBHOOK_PRUNE_INTERVAL_MS } = await import("./lib/constants");
  const { startSalesLeadPoller } = await import("./lib/sales-lead-sync");
  const { startClientOnboarding } = await import("./lib/client-onboarding-sync");
  const { startBillingRequests } = await import("./lib/billing-request-sync");
  const { startContactStripeSync } = await import("./lib/contact-stripe-sync");
  const { startPortalMirror } = await import("./lib/portal-mirror-sync");
  const { startBillingMirror } = await import("./lib/billing-mirror-sync");
  const { pool } = await import("./db/client");

  const server = await buildServer();
  let salesLeadPoller: { stop(): Promise<void> } | null = null;
  let clientOnboarding: { stop(): Promise<void> } | null = null;
  let billingRequests: { stop(): Promise<void> } | null = null;
  let contactStripeSync: { stop(): Promise<void> } | null = null;
  let portalMirror: { stop(): Promise<void> } | null = null;
  let billingMirror: { stop(): Promise<void> } | null = null;

  try {
    if (process.env.NODE_ENV !== "production") {
      await runMigrations(server);
    }
    await verifyDatabaseSchema();

    // Prune processed webhook_events past their retention window: once at
    // boot, then on a recurring sweep. Failures here are logged, not fatal —
    // this is maintenance, not a request-serving dependency.
    const runWebhookPrune = async () => {
      try {
        const deleted = await pruneProcessedWebhookEvents();
        if (deleted > 0) {
          server.log.info({ deleted }, "Pruned processed webhook_events past retention window.");
        }
      } catch (err) {
        server.log.error(errorLogFields(err), "Failed to prune processed webhook_events.");
      }
    };
    await runWebhookPrune();
    setInterval(runWebhookPrune, WEBHOOK_PRUNE_INTERVAL_MS).unref();

    await server.listen({
      port: Number(process.env.PORT) || 4242,
      host: process.env.HOST || "0.0.0.0",
    });

    // New Lead automation: off unless SALES_AUTOMATION_ENABLED=true. A bad config is
    // logged and the poller stays off; it never stops the payment API from serving.
    salesLeadPoller = startSalesLeadPoller(server.log);
    // Client onboarding: off unless CLIENT_ONBOARDING_ENABLED=true. Same guarantees.
    clientOnboarding = startClientOnboarding(server.log);
    // "New invoice" form -> Stripe invoices and plans: off unless BILLING_REQUESTS_ENABLED=true. Same guarantees.
    billingRequests = startBillingRequests(server.log);
    // Contact card -> billing Stripe Customer: off unless CONTACT_STRIPE_SYNC=true. Same guarantees.
    contactStripeSync = startContactStripeSync(server.log);
    // Portal Accounts -> Nextcloud Table (read-only mirror): off unless PORTAL_MIRROR=true. Same guarantees.
    portalMirror = startPortalMirror(server.log);
    // Client Billing -> Nextcloud Table (read-only; Stripe is only read): off unless BILLING_MIRROR=true. Same guarantees.
    billingMirror = startBillingMirror(server.log);
  } catch (err) {
    server.log.error(errorLogFields(err));
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    server.log.info({ signal }, "Received signal, shutting down gracefully");
    try {
      await salesLeadPoller?.stop();
      await clientOnboarding?.stop();
      await billingRequests?.stop();
      await contactStripeSync?.stop();
      await portalMirror?.stop();
      await billingMirror?.stop();
      await server.close();
      await pool.end();
      server.log.info("Server closed successfully");
      process.exit(0);
    } catch (err) {
      server.log.error(errorLogFields(err), "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();
