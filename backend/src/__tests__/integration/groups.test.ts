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
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

const createdGroupIds: string[] = [];
const workspace = "client_portal";

describe("Groups API", () => {
  let app: any;

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });

  afterAll(async () => {
    // Clean up any groups created during tests
    for (const id of createdGroupIds) {
      await db
        .delete(clientGroups)
        .where(eq(clientGroups.id, id))
        .catch(() => undefined);
    }
    if (app) await app.close();
  });

  // ── POST /groups ──────────────────────────────────────────────────────────

  describe("POST /api/v1/groups", () => {
    it("returns 201 with the created group", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/groups",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Test Group A", workspace },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.name).toBe("Test Group A");
      expect(body.workspace).toBe(workspace);
      expect(body.status).toBe("active");
      expect(body.id).toBeTruthy();
      expect(body.id).toEqual(expect.any(String));
      expect(body.createdAt).toBeDefined();
      expect(body.createdAt).not.toBeNull();
      expect(body.updatedAt).toBeDefined();
      expect(body.updatedAt).not.toBeNull();
      createdGroupIds.push(body.id);
    });

    it("returns 400 when name is missing", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/groups",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { workspace },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/name/i);
    });

    it("returns 400 when name is an empty string", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/groups",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "   ", workspace },
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 when workspace is invalid", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/groups",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Bad Workspace Group", workspace: "not_a_real_workspace" },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ── GET /groups ───────────────────────────────────────────────────────────

  describe("GET /api/v1/groups", () => {
    it("returns 200 with an array of groups", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/groups?workspace=${workspace}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
      expect(body.total).toBeGreaterThanOrEqual(body.data.length);
    });

    it("paginates groups", async () => {
      const ids = [randomUUID(), randomUUID()];
      createdGroupIds.push(...ids);
      await db.insert(clientGroups).values(
        ids.map((id, index) => ({
          id,
          name: `Paged Group ${index}`,
          workspace,
          status: "active",
        }))
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/groups?workspace=${workspace}&limit=1&offset=0`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(0);
      expect(body.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe("DELETE /api/v1/groups/:id", () => {
    it("deletes a group and clears client group references", async () => {
      const token = makeAdminToken();
      const groupId = randomUUID();
      const clientId = randomUUID();
      createdGroupIds.push(groupId);

      await db.insert(clientGroups).values({ id: groupId, name: "Delete Group", workspace });
      await db.insert(clients).values({
        id: clientId,
        name: "Grouped Client",
        email: `grouped-${clientId}@example.com`,
        workspace,
        status: "active",
        groupId,
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(204);
      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      expect(client.groupId).toBeNull();
      await db.delete(clients).where(eq(clients.id, clientId));
    });

    it("returns 404 when group does not exist", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/groups/${randomUUID()}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Group not found.");
    });
  });

  // ── PATCH /groups/:id ─────────────────────────────────────────────────────

  describe("PATCH /api/v1/groups/:id", () => {
    let groupId: string;

    // Create a fresh group for patch tests
    beforeAll(async () => {
      const token = makeAdminToken();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/groups",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Patch Test Group", workspace },
      });
      groupId = res.json().id;
      createdGroupIds.push(groupId);
    });

    it("returns 200 when updating name and status", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "Renamed Group", status: "inactive" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe("Renamed Group");
      expect(body.status).toBe("inactive");
    });

    it("returns 200 when setting processingFeeCents", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { processingFeeCents: 250 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().processingFeeCents).toBe(250);
    });

    it("returns 200 when setting processingFeePercent", async () => {
      const token = makeAdminToken();

      // First clear the cents fee, then set percent
      await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { processingFeeCents: null },
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { processingFeePercent: 2.5 },
      });

      expect(response.statusCode).toBe(200);
      // processingFeePercent is stored as numeric string in postgres
      expect(Number(response.json().processingFeePercent)).toBeCloseTo(2.5);
    });

    it("returns 200 when setting paymentSuccessUrl and paymentCancelUrl", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          paymentSuccessUrl: "https://example.com/success",
          paymentCancelUrl: "https://example.com/cancel",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().paymentSuccessUrl).toBe("https://example.com/success");
      expect(response.json().paymentCancelUrl).toBe("https://example.com/cancel");
    });

    it("returns 400 when both processingFeePercent and processingFeeCents are provided", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { processingFeePercent: 2, processingFeeCents: 100 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/one fee type/i);
    });

    it("returns 400 when processingFeePercent is out of range (> 100)", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { processingFeePercent: 150 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/processingFeePercent/i);
    });

    it("returns 400 when processingFeePercent is zero or negative", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { processingFeePercent: 0 },
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 when processingFeeCents is negative", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { processingFeeCents: -1 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/processingFeeCents/i);
    });

    it("returns 400 when processingFeeCents is not an integer", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { processingFeeCents: 1.5 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/processingFeeCents/i);
    });

    it("returns 400 when paymentSuccessUrl is not a valid HTTPS URL", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { paymentSuccessUrl: "http://example.com/success" }, // http, not https
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/paymentSuccessUrl/i);
    });

    it("returns 400 when paymentCancelUrl is not a valid HTTPS URL", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { paymentCancelUrl: "not-a-url" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/paymentCancelUrl/i);
    });

    it("returns 400 when status is an invalid value", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { status: "suspended" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/status/i);
    });

    it("returns 400 when name is an empty string", async () => {
      const token = makeAdminToken();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${groupId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/name/i);
    });

    it("returns 404 when the group does not exist", async () => {
      const token = makeAdminToken();
      const nonExistentId = `grp-${randomUUID().replace(/-/g, "").slice(0, 16)}`;

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${nonExistentId}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { name: "New Name" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/not found/i);
    });
  });
});
