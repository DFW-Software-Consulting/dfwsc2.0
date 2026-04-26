import { buildServer } from "./app";
import { runMigrations } from "./lib/migrate";
import { verifyDatabaseSchema } from "./lib/schema-check";
import { startNextcloudPolling } from "./lib/nextcloud-poll";

export async function start() {
  const server = await buildServer();

  try {
    await runMigrations(server);
    await verifyDatabaseSchema();
    startNextcloudPolling();
    await server.listen({ port: Number(process.env.PORT) || 4242, host: "0.0.0.0" });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// For backward compatibility when running directly
if (require.main === module) {
  start();
}
