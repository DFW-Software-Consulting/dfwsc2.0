import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { admins } from "../db/schema";

export async function bootstrapAdminIfNeeded(server: FastifyInstance): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const allowAdminSetup = process.env.ALLOW_ADMIN_SETUP === "true";

  const existingAdmins = await db.select().from(admins);

  if (existingAdmins.length > 0) {
    // Bootstrap only ever seeds an empty table. Matching on ADMIN_USERNAME alone would
    // re-create a second admin with the bootstrap password once the first admin renames
    // themselves during setup confirmation.
    if (password && existingAdmins.some((admin) => admin.setupConfirmed)) {
      // Rows seeded by the earlier behaviour are left in place, so name any active account
      // that still accepts the bootstrap password instead of implying it is unused.
      const stillAccepting: string[] = [];
      for (const admin of existingAdmins) {
        if (admin.active === false || !admin.passwordHash) continue;
        if (await bcrypt.compare(password, admin.passwordHash)) {
          stillAccepting.push(admin.username);
        }
      }

      if (stillAccepting.length > 0) {
        server.log.warn(
          { usernames: stillAccepting },
          "ADMIN_PASSWORD still signs in to the listed admin accounts. Change their passwords or remove the accounts, then remove ADMIN_USERNAME and ADMIN_PASSWORD from the environment."
        );
      } else {
        server.log.warn(
          "ADMIN_PASSWORD is still set although a confirmed admin exists. It is ignored from now on: remove ADMIN_USERNAME and ADMIN_PASSWORD from the environment."
        );
      }
    }
    return;
  }

  if (!username || !password) {
    server.log.warn(
      "Bootstrap warning: No admins in DB and no ADMIN_USERNAME/ADMIN_PASSWORD provided. Login will return 503."
    );
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
}
