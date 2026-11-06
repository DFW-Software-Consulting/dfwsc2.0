import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients } from "../../db/schema";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

describe("GET /api/v1/clients onboarding state", () => {
  let app: any;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(async () => {
    for (const id of cleanupIds.splice(0)) {
      await db.delete(clients).where(eq(clients.id, id));
    }
  });

  async function seed(values: Partial<typeof clients.$inferInsert>) {
    const id = randomUUID();
    cleanupIds.push(id);
    await db.insert(clients).values({
      id,
      name: "Onboarding State Client",
      email: `${id}@example.com`,
      workspace: "client_portal",
      status: "active",
      ...values,
    });
    return id;
  }

  async function listRow(id: string) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/clients?workspace=client_portal&limit=100",
      headers: { authorization: `Bearer ${makeAdminToken()}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json().data.find((c: any) => c.id === id);
  }

  it("returns the Stripe readiness booleans for each client", async () => {
    const notStarted = await seed({});
    const inProgress = await seed({ stripeAccountId: "acct_in_progress", detailsSubmitted: true });
    const ready = await seed({
      stripeAccountId: "acct_ready",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });

    expect(await listRow(notStarted)).toMatchObject({
      chargesEnabled: false,
      detailsSubmitted: false,
      payoutsEnabled: false,
    });
    expect(await listRow(inProgress)).toMatchObject({
      stripeAccountId: "acct_in_progress",
      chargesEnabled: false,
      detailsSubmitted: true,
      payoutsEnabled: false,
    });
    expect(await listRow(ready)).toMatchObject({
      chargesEnabled: true,
      detailsSubmitted: true,
      payoutsEnabled: true,
    });
  });

  it("does not leak credential columns in list rows", async () => {
    const id = await seed({ apiKeyHash: "hash-should-not-appear", apiKeyLookup: "lookup-secret" });
    const row = await listRow(id);

    expect(row).not.toHaveProperty("apiKeyHash");
    expect(row).not.toHaveProperty("apiKeyLookup");
    expect(JSON.stringify(row)).not.toContain("hash-should-not-appear");
  });
});
