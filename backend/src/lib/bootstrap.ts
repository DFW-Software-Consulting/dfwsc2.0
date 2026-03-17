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

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    server.log.warn(
      "Bootstrap warning: ADMIN_USERNAME/ADMIN_PASSWORD not set and no admins in DB. " +
        "Server will start but login will return 503 until an admin is configured."
    );
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await db.insert(admins).values({
    id: randomUUID(),
    username,
    passwordHash,
    role: "admin",
    active: true,
    setupConfirmed: false,
  });

  server.log.info({ username }, "Bootstrap admin created");
}
