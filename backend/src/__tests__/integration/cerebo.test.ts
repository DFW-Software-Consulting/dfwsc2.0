import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
  },
}));

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { resetNextcloudBreakerForTests, summarizeDeckStacks } from "../../cerebo/nextcloud";
import { auditEvents, milestones, projects, resourceLinks } from "../../cerebo/schema";
import { db } from "../../db/client";
import { admins, clients } from "../../db/schema";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

const run = randomUUID().slice(0, 8);
const adminId = `cerebo-admin-${run}`;
const clientA = `cerebo-client-a-${run}`;
const clientB = `cerebo-client-b-${run}`;

const NEXTCLOUD_ENV = ["NEXTCLOUD_BASE_URL", "NEXTCLOUD_USERNAME", "NEXTCLOUD_APP_PASSWORD"];

describe("Cerebo API", () => {
  let app: any;
  const savedEnv: Record<string, string | undefined> = {};

  const call = (method: string, url: string, payload?: unknown, sub: string | null = adminId) =>
    app.inject({
      method,
      url: `/api/v1/cerebo${url}`,
      headers: {
        authorization: `Bearer ${sub ? makeAdminToken(undefined, { sub }) : makeAdminToken()}`,
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      ...(payload ? { payload } : {}),
    });

  async function createProject(clientId: string, body: Record<string, unknown> = {}) {
    const res = await call("POST", `/clients/${clientId}/projects`, { name: "Website", ...body });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; clientId: string };
  }

  beforeAll(async () => {
    ensureBaseEnv();
    for (const key of NEXTCLOUD_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CEREBO_ENABLED = "true";
    app = await buildServer();
    await db
      .insert(admins)
      .values({ id: adminId, username: adminId, passwordHash: "unused", setupConfirmed: true });
    await db.insert(clients).values([
      { id: clientA, name: "Client A", email: `${clientA}@example.test` },
      { id: clientB, name: "Client B", email: `${clientB}@example.test` },
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetNextcloudBreakerForTests();
    for (const key of NEXTCLOUD_ENV) delete process.env[key];
  });

  afterAll(async () => {
    const ids = [clientA, clientB];
    await db.delete(auditEvents).where(inArray(auditEvents.clientId, ids));
    await db.delete(resourceLinks).where(inArray(resourceLinks.clientId, ids));
    await db.delete(projects).where(inArray(projects.clientId, ids));
    await db.delete(clients).where(inArray(clients.id, ids));
    await db.delete(admins).where(eq(admins.id, adminId));
    delete process.env.CEREBO_ENABLED;
    for (const key of NEXTCLOUD_ENV) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    }
    if (app) await app.close();
  });

  it("is not served when CEREBO_ENABLED is unset", async () => {
    delete process.env.CEREBO_ENABLED;
    const plain = await buildServer();
    process.env.CEREBO_ENABLED = "true";
    try {
      const res = await plain.inject({
        method: "GET",
        url: `/api/v1/cerebo/clients/${clientA}/projects`,
        headers: { authorization: `Bearer ${makeAdminToken(undefined, { sub: adminId })}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it("requires an admin session", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/cerebo/clients/${clientA}/projects` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects admin tokens without an identity", async () => {
    const res = await call("GET", `/clients/${clientA}/projects`, undefined, null);
    expect(res.statusCode).toBe(403);
  });

  describe("projects", () => {
    it("answers 404 for an unknown client", async () => {
      const res = await call("POST", "/clients/no-such-client/projects", { name: "x" });
      expect(res.statusCode).toBe(404);
    });

    it("validates dates", async () => {
      const res = await call("POST", `/clients/${clientA}/projects`, {
        name: "Bad dates",
        startsOn: "2026-05-01",
        endsOn: "2026-04-01",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("endsOn must be on or after startsOn.");
    });

    it("lists only the requested client's projects", async () => {
      const a = await createProject(clientA, { name: "A only" });
      const b = await createProject(clientB, { name: "B only" });
      const res = await call("GET", `/clients/${clientA}/projects?limit=100`);
      expect(res.statusCode).toBe(200);
      const ids = res.json().data.map((p: { id: string }) => p.id);
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(b.id);
    });

    it("checks date order against the stored value on patch", async () => {
      const p = await createProject(clientA, { startsOn: "2026-06-01" });
      const res = await call("PATCH", `/projects/${p.id}`, { endsOn: "2026-05-01" });
      expect(res.statusCode).toBe(400);
    });

    it("audits creation and field-level updates", async () => {
      const p = await createProject(clientA, { name: "Audited" });
      const patched = await call("PATCH", `/projects/${p.id}`, { status: "active" });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().status).toBe("active");

      const res = await call("GET", `/audit?entityType=project&entityId=${p.id}`);
      const events = res.json().data;
      expect(events.map((e: { action: string }) => e.action).sort()).toEqual(["create", "update"]);
      const update = events.find((e: { action: string }) => e.action === "update");
      expect(update.actorId).toBe(adminId);
      expect(update.clientId).toBe(clientA);
      expect(update.changes).toEqual({ status: { from: "planned", to: "active" } });
    });

    it("does not audit a patch that changes nothing", async () => {
      const p = await createProject(clientA, { name: "Same" });
      await call("PATCH", `/projects/${p.id}`, { name: "Same" });
      const res = await call("GET", `/audit?entityType=project&entityId=${p.id}`);
      expect(res.json().total).toBe(1);
    });
  });

  describe("milestones", () => {
    it("sets and clears completedAt as status enters and leaves done", async () => {
      const p = await createProject(clientA);
      const created = await call("POST", `/projects/${p.id}/milestones`, { title: "Launch" });
      expect(created.statusCode).toBe(201);
      const m = created.json();
      expect(m.clientId).toBe(clientA);
      expect(m.completedAt).toBeNull();
      expect(m.clientVisible).toBe(false);

      const done = await call("PATCH", `/milestones/${m.id}`, { status: "done" });
      expect(done.json().completedAt).not.toBeNull();
      const reopened = await call("PATCH", `/milestones/${m.id}`, { status: "in_progress" });
      expect(reopened.json().completedAt).toBeNull();
    });

    it("rejects an invoice id that is not a Stripe invoice", async () => {
      const p = await createProject(clientA);
      const res = await call("POST", `/projects/${p.id}/milestones`, {
        title: "Deposit",
        stripeInvoiceId: "pi_123",
      });
      expect(res.statusCode).toBe(400);
    });

    it("answers 404 for an unknown project", async () => {
      const res = await call("POST", "/projects/nope/milestones", { title: "x" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("client isolation", () => {
    it("refuses a link to another client's project", async () => {
      const bProject = await createProject(clientB);
      const res = await call("POST", `/clients/${clientA}/links`, {
        projectId: bProject.id,
        kind: "deck_board",
        externalId: "7",
      });
      expect(res.statusCode).toBe(404);
    });

    it("refuses a cross-client milestone at the database level", async () => {
      const bProject = await createProject(clientB);
      await expect(
        db.insert(milestones).values({
          id: randomUUID(),
          clientId: clientA,
          projectId: bProject.id,
          title: "Smuggled",
        })
      ).rejects.toThrow();
    });
  });

  describe("resource links", () => {
    it("separates client-level links from project links and rejects duplicates", async () => {
      const p = await createProject(clientA);
      const clientLink = await call("POST", `/clients/${clientA}/links`, {
        kind: "collective",
        externalId: `collective-${run}`,
        url: "https://cloud.example.com/apps/collectives/acme",
      });
      expect(clientLink.statusCode).toBe(201);
      const projectLink = await call("POST", `/clients/${clientA}/links`, {
        projectId: p.id,
        kind: "files_folder",
        externalId: `/clients/a/${run}`,
      });
      expect(projectLink.statusCode).toBe(201);

      const list = await call("GET", `/clients/${clientA}/links`);
      const ids = list.json().data.map((l: { id: string }) => l.id);
      expect(ids).toContain(clientLink.json().id);
      expect(ids).not.toContain(projectLink.json().id);

      const dup = await call("POST", `/clients/${clientA}/links`, {
        kind: "collective",
        externalId: `collective-${run}`,
      });
      expect(dup.statusCode).toBe(409);
    });

    it("rejects a non-HTTPS url and an unknown kind", async () => {
      const http = await call("POST", `/clients/${clientA}/links`, {
        kind: "talk_room",
        externalId: "abc",
        url: "http://insecure.example.com",
      });
      expect(http.statusCode).toBe(400);
      const kind = await call("POST", `/clients/${clientA}/links`, { kind: "ftp", externalId: "x" });
      expect(kind.statusCode).toBe(400);
    });

    it("deletes a link and audits it", async () => {
      const created = await call("POST", `/clients/${clientA}/links`, {
        kind: "talk_room",
        externalId: `room-${run}`,
      });
      const id = created.json().id;
      expect((await call("DELETE", `/links/${id}`)).statusCode).toBe(204);
      expect((await call("DELETE", `/links/${id}`)).statusCode).toBe(404);
      const audit = await call("GET", `/audit?entityType=resource_link&entityId=${id}`);
      expect(audit.json().data.map((e: { action: string }) => e.action)).toContain("delete");
    });
  });

  describe("Nextcloud Deck progress", () => {
    async function projectWithBoard(boardId: string) {
      const p = await createProject(clientA);
      await call("POST", `/clients/${clientA}/links`, {
        projectId: p.id,
        kind: "deck_board",
        externalId: boardId,
      });
      return p;
    }

    it("reports not_configured without Nextcloud credentials", async () => {
      const p = await projectWithBoard(`${Date.now()}1`);
      const res = await call("GET", `/projects/${p.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().deck[0].status).toBe("not_configured");
      expect((await call("GET", "/nextcloud/status")).json().status).toBe("not_configured");
    });

    it("summarizes the board when Nextcloud answers", async () => {
      process.env.NEXTCLOUD_BASE_URL = "https://cloud.example.com/";
      process.env.NEXTCLOUD_USERNAME = "cerebo-bot";
      process.env.NEXTCLOUD_APP_PASSWORD = "secret";
      const fetchMock = vi.fn(async () =>
        Response.json([
          {
            id: 1,
            title: "To do",
            order: 0,
            cards: [
              { id: 1, title: "a", duedate: "2000-01-01T00:00:00Z", done: null, archived: false },
              { id: 2, title: "b", duedate: null, done: null, archived: true },
            ],
          },
          {
            id: 2,
            title: "Done",
            order: 1,
            cards: [{ id: 3, title: "c", duedate: null, done: "2026-01-01", archived: false }],
          },
        ])
      );
      vi.stubGlobal("fetch", fetchMock);
      const boardId = `${Date.now()}2`;
      const p = await projectWithBoard(boardId);
      const res = await call("GET", `/projects/${p.id}`);
      const deck = res.json().deck[0];
      expect(deck).toMatchObject({ status: "ok", totalCards: 2, doneCards: 1, overdueCards: 1 });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`https://cloud.example.com/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`);
      expect((init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    });

    it("degrades instead of failing when Nextcloud errors", async () => {
      process.env.NEXTCLOUD_BASE_URL = "https://cloud.example.com";
      process.env.NEXTCLOUD_USERNAME = "cerebo-bot";
      process.env.NEXTCLOUD_APP_PASSWORD = "secret";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("nope", { status: 403 }))
      );
      const p = await projectWithBoard(`${Date.now()}3`);
      const res = await call("GET", `/projects/${p.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().deck[0]).toMatchObject({
        status: "unavailable",
        reason: "Not found, or not shared with the Cerebo service account.",
      });
    });

    it("never calls Nextcloud with a non-numeric board id", async () => {
      process.env.NEXTCLOUD_BASE_URL = "https://cloud.example.com";
      process.env.NEXTCLOUD_USERNAME = "cerebo-bot";
      process.env.NEXTCLOUD_APP_PASSWORD = "secret";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const p = await projectWithBoard(`../../users-${run}`);
      const res = await call("GET", `/projects/${p.id}`);
      expect(res.json().deck[0].status).toBe("unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("summarizeDeckStacks", () => {
  it("orders stacks and ignores archived cards", () => {
    const summary = summarizeDeckStacks("1", [
      { id: 2, title: "Later", order: 5, cards: [] },
      { id: 1, title: "First", order: 0 },
    ]);
    expect(summary).toMatchObject({ status: "ok", totalCards: 0 });
    if (summary.status === "ok") expect(summary.stacks.map((s) => s.id)).toEqual([1, 2]);
  });
});
