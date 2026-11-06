import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

// Far-future timestamps keep these rows ahead of anything else in the table, so
// the first rows of a newest-first list are the ones seeded here.
const FUTURE = Date.UTC(2999, 0, 1);

describe("admin list endpoints ordering", () => {
  let app: any;
  const clientIds: string[] = [];
  const groupIds: string[] = [];
  const auth = () => ({ authorization: `Bearer ${makeAdminToken()}` });

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(async () => {
    for (const id of clientIds.splice(0)) await db.delete(clients).where(eq(clients.id, id));
    for (const id of groupIds.splice(0))
      await db.delete(clientGroups).where(eq(clientGroups.id, id));
  });

  it("lists clients newest first, breaking ties by id", async () => {
    const [older, newerB, newerA] = [randomUUID(), `b-${randomUUID()}`, `a-${randomUUID()}`];
    const rows = [
      { id: older, createdAt: new Date(FUTURE) },
      { id: newerB, createdAt: new Date(FUTURE + 60_000) },
      { id: newerA, createdAt: new Date(FUTURE + 60_000) },
    ];
    for (const row of rows) {
      clientIds.push(row.id);
      await db.insert(clients).values({
        ...row,
        name: "Ordering Client",
        email: `${row.id}@example.com`,
        workspace: "client_portal",
        status: "active",
      });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/clients?workspace=client_portal&limit=3",
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((c: any) => c.id)).toEqual([newerA, newerB, older]);
  });

  it("lists groups newest first, breaking ties by id", async () => {
    const [older, newerB, newerA] = [randomUUID(), `b-${randomUUID()}`, `a-${randomUUID()}`];
    const rows = [
      { id: older, createdAt: new Date(FUTURE) },
      { id: newerB, createdAt: new Date(FUTURE + 60_000) },
      { id: newerA, createdAt: new Date(FUTURE + 60_000) },
    ];
    for (const row of rows) {
      groupIds.push(row.id);
      await db.insert(clientGroups).values({
        ...row,
        name: "Ordering Group",
        workspace: "client_portal",
        status: "active",
      });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/groups?workspace=client_portal&limit=3",
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((g: any) => g.id)).toEqual([newerA, newerB, older]);
  });

  it("pages without repeating or skipping rows", async () => {
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      clientIds.push(id);
      await db.insert(clients).values({
        id,
        createdAt: new Date(FUTURE + i * 1000),
        name: "Paging Client",
        email: `${id}@example.com`,
        workspace: "client_portal",
        status: "active",
      });
    }

    const get = async (offset: number) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/clients?workspace=client_portal&limit=2&offset=${offset}`,
          headers: auth(),
        })
      )
        .json()
        .data.map((c: any) => c.id);

    const pages = [...(await get(0)), ...(await get(2))];
    expect(new Set(pages).size).toBe(4);
    expect(pages).toEqual([...clientIds].reverse());
  });
});
