import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { admins } from "../db/schema";

export async function bootstrapAdminIfNeeded(server: FastifyInstance): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const allowAdminSetup = process.env.ALLOW_ADMIN_SETUP === "true";

  if (username && password) {
    const existing = await db.select().from(admins).where(eq(admins.username, username)).limit(1);

    if (existing.length > 0) {
      server.log.info({ username }, "Bootstrap: admin account already exists.");
      return;
    }

    server.log.info({ username }, "Bootstrapping admin account from environment...");
    const passwordHash = await bcrypt.hash(password, 10);
    await db.insert(admins).values({
      id: randomUUID(),
      username,
      passwordHash,
      setupConfirmed: !allowAdminSetup,
      updatedAt: new Date(),
    });

    if (allowAdminSetup) {
      server.log.info(
        { username },
        "Admin account bootstrapped in unconfirmed mode because ALLOW_ADMIN_SETUP=true."
      );
    } else {
      server.log.info({ username }, "Admin account bootstrapped successfully.");
    }
    return;
  }

  const allAdmins = await db.select().from(admins);
  if (allAdmins.length === 0) {
    server.log.warn(
      "Bootstrap warning: No admins in DB and no ADMIN_USERNAME/ADMIN_PASSWORD provided. Login will return 503."
    );
  }
}
