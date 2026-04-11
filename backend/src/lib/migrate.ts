import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";

const migrationsFolder = path.join(__dirname, "..", "..", "drizzle");

export async function runMigrations(server: FastifyInstance): Promise<void> {
  try {
    await migrate(db, { migrationsFolder });
    server.log.info("Database migrations executed (noop if already up to date).");
  } catch (error) {
    server.log.error({ err: error }, "Failed to execute database migrations.");
    // In dev, we might want to continue even if migrations fail (e.g. if schema already exists)
    if (process.env.NODE_ENV !== "production") {
      server.log.warn("Continuing despite migration failure (dev mode).");
      return;
    }
    throw error;
  }
}
