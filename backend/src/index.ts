import path from "node:path";
import dotenv from "dotenv";

// Load environment variables synchronously before any other imports
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
}

// Now import and start the server after env vars are loaded
async function start() {
  const { buildServer } = await import("./app");
  const { runMigrations } = await import("./lib/migrate");
  const { bootstrapAdminIfNeeded } = await import("./lib/bootstrap");
  const { verifyDatabaseSchema } = await import("./lib/schema-check");
  const { pruneProcessedWebhookEvents } = await import("./lib/webhook-retention");
  const { WEBHOOK_PRUNE_INTERVAL_MS } = await import("./lib/constants");
  const { pool } = await import("./db/client");

  const server = await buildServer();

  try {
    if (process.env.NODE_ENV !== "production") {
      await runMigrations(server);
    }
    await verifyDatabaseSchema();
    await bootstrapAdminIfNeeded(server);

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
        server.log.error({ err }, "Failed to prune processed webhook_events.");
      }
    };
    await runWebhookPrune();
    setInterval(runWebhookPrune, WEBHOOK_PRUNE_INTERVAL_MS).unref();

    await server.listen({
      port: Number(process.env.PORT) || 4242,
      host: process.env.HOST || "0.0.0.0",
    });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    server.log.info({ signal }, "Received signal, shutting down gracefully");
    try {
      await server.close();
      await pool.end();
      server.log.info("Server closed successfully");
      process.exit(0);
    } catch (err) {
      server.log.error(err, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();
