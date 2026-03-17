import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { admins } from "../db/schema";

export async function bootstrapAdminIfNeeded(server: FastifyInstance): Promise<void> {
  const existing = await db.select().from(admins);

  if (existing.length > 0) {
    server.log.info("Bootstrap skipped — admin already configured");
    return;
  }

  server.log.warn(
    "Bootstrap warning: No admins in DB. Server will start but login will return 503 until an admin is configured via the setup endpoint or manually in the database."
  );
}
