import { vi } from "vitest";

// Mock Stripe before importing anything else
vi.mock("../../lib/stripe", () => ({
  stripe: {
    customers: {
      list: vi.fn(),
      retrieve: vi.fn(),
    },
  },
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

describe("Clients API Integration", () => {
  let app: any;
  let cleanupIds: string[] = [];
  let cleanupGroupIds: string[] = [];
  const workspace = "dfwsc_services";

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const id of cleanupIds) {
      await db.delete(clients).where(eq(clients.id, id));
    }
    for (const id of cleanupGroupIds) {
      await db.delete(clientGroups).where(eq(clientGroups.id, id));
    }
    cleanupIds = [];
    cleanupGroupIds = [];
  });

  describe("GET /api/v1/clients", () => {
    it("returns 401 if not authenticated", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/clients?workspace=dfwsc_services",
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns 400 when workspace is missing", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/clients",
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/workspace query parameter is required/i);
    });

    it("returns 400 when workspace is invalid", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/clients?workspace=invalid_workspace",
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/workspace query parameter is required/i);
    });

    it("returns 400 when groupId does not belong to workspace", async () => {
      const groupId = randomUUID();
      cleanupGroupIds.push(groupId);

      // Create a group in client_portal workspace
      await db.insert(clientGroups).values({
        id: groupId,
        name: "Test Group",
        workspace: "client_portal",
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients?workspace=dfwsc_services&groupId=${groupId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("groupId does not belong to the selected workspace.");
    });

    it("returns empty array when no clients exist in workspace", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients?workspace=${workspace}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it("lists clients filtered by workspace", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients?workspace=${workspace}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.some((c: any) => c.id === clientId)).toBe(true);
    });

    it("lists clients filtered by groupId", async () => {
      const groupId = randomUUID();
      const clientId = randomUUID();
      cleanupGroupIds.push(groupId);
      cleanupIds.push(clientId);

      await db.insert(clientGroups).values({
        id: groupId,
        name: "Test Group",
        workspace,
        status: "active",
      });

      await db.insert(clients).values({
        id: clientId,
        name: "Grouped Client",
        email: "grouped@example.com",
        workspace,
        groupId,
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients?workspace=${workspace}&groupId=${groupId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.every((c: any) => c.groupId === groupId)).toBe(true);
    });
  });

  describe("PATCH /api/v1/clients/:id", () => {
    it("returns 401 if not authenticated", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/clients/some-id",
        payload: { status: "inactive" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns 404 when client does not exist", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${randomUUID()}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { status: "inactive" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Client not found.");
    });

    it("returns 400 when status is invalid", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { status: "invalid_status" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/Invalid status value/i);
    });

    it("returns 400 when paymentSuccessUrl is not HTTPS", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { paymentSuccessUrl: "http://example.com/success" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("paymentSuccessUrl must be a valid HTTPS URL.");
    });

    it("returns 400 when paymentCancelUrl is not HTTPS", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { paymentCancelUrl: "ftp://example.com/cancel" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("paymentCancelUrl must be a valid HTTPS URL.");
    });

    it("returns 400 when both fee types are set", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeePercent: 5, processingFeeCents: 100 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Set one fee type, not both.");
    });

    it("returns 400 when processingFeePercent is out of range", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeePercent: 150 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/processingFeePercent must be greater than 0/i);
    });

    it("returns 400 when processingFeePercent is zero or negative", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeePercent: 0 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/processingFeePercent must be greater than 0/i);
    });

    it("returns 400 when processingFeeCents is negative", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeeCents: -50 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("processingFeeCents must be a non-negative integer.");
    });

    it("returns 400 when processingFeeCents is not an integer", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeeCents: 50.5 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("processingFeeCents must be a non-negative integer.");
    });

    it("returns 400 when groupId does not exist", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { groupId: randomUUID() },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Group not found.");
    });

    it("returns 400 when groupId workspace does not match client workspace", async () => {
      const clientId = randomUUID();
      const groupId = randomUUID();
      cleanupIds.push(clientId);
      cleanupGroupIds.push(groupId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      await db.insert(clientGroups).values({
        id: groupId,
        name: "Test Group",
        workspace: "client_portal",
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { groupId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("groupId workspace does not match client workspace.");
    });

    it("successfully updates client status", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { status: "inactive" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("inactive");
    });

    it("successfully updates client with valid HTTPS URLs", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: {
          paymentSuccessUrl: "https://example.com/success",
          paymentCancelUrl: "https://example.com/cancel",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().paymentSuccessUrl).toBe("https://example.com/success");
      expect(response.json().paymentCancelUrl).toBe("https://example.com/cancel");
    });

    it("successfully clears payment URLs by setting to null", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
        paymentSuccessUrl: "https://example.com/success",
        paymentCancelUrl: "https://example.com/cancel",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: {
          paymentSuccessUrl: null,
          paymentCancelUrl: null,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().paymentSuccessUrl).toBeNull();
      expect(response.json().paymentCancelUrl).toBeNull();
    });

    it("successfully updates processingFeePercent", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeePercent: 3.5 },
      });

      expect(response.statusCode).toBe(200);
      expect(parseFloat(response.json().processingFeePercent)).toBe(3.5);
    });

    it("successfully updates processingFeeCents", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeeCents: 150 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().processingFeeCents).toBe(150);
    });

    it("successfully clears fee settings by setting to null", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
        processingFeePercent: "3.5",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeePercent: null },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().processingFeePercent).toBeNull();
    });

    it("successfully assigns client to a group", async () => {
      const clientId = randomUUID();
      const groupId = randomUUID();
      cleanupIds.push(clientId);
      cleanupGroupIds.push(groupId);

      await db.insert(clientGroups).values({
        id: groupId,
        name: "Test Group",
        workspace,
        status: "active",
      });

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { groupId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().groupId).toBe(groupId);
    });

    it("successfully removes client from group by setting groupId to null", async () => {
      const clientId = randomUUID();
      const groupId = randomUUID();
      cleanupIds.push(clientId);
      cleanupGroupIds.push(groupId);

      await db.insert(clientGroups).values({
        id: groupId,
        name: "Test Group",
        workspace,
        status: "active",
      });

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace,
        groupId,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { groupId: null },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().groupId).toBeNull();
    });
  });
});
