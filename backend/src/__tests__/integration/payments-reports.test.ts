import { vi } from "vitest";

// Mock Stripe before importing anything else
vi.mock("../../lib/stripe", () => ({
  stripe: {
    paymentIntents: {
      list: vi.fn(),
      create: vi.fn(),
    },
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
    customers: {
      create: vi.fn(),
    },
  },
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";
import { stripe } from "../../lib/stripe";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

const mockPaymentIntentsList = stripe.paymentIntents.list as ReturnType<typeof vi.fn>;

describe("Payments Reports API Integration", () => {
  let app: any;
  let cleanupIds: string[] = [];
  let cleanupGroupIds: string[] = [];

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

  describe("GET /api/v1/reports/payments", () => {
    it("returns 401 if not authenticated", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/reports/payments?workspace=dfwsc_services&clientId=test",
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns 400 when workspace is missing", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/reports/payments?clientId=test",
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/workspace query parameter is required/i);
    });

    it("returns 400 when neither clientId nor groupId provided for non-DFWSC workspace", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/reports/payments?workspace=client_portal",
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("clientId or groupId query parameter is required.");
    });

    it("returns 400 when limit is invalid", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace: "dfwsc_services",
        stripeAccountId: "acct_test",
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&clientId=${clientId}&limit=200`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("limit must be an integer between 1 and 100.");
    });

    it("aggregates payments for a group", async () => {
      const groupId = randomUUID();
      const clientId1 = randomUUID();
      const clientId2 = randomUUID();
      cleanupGroupIds.push(groupId);
      cleanupIds.push(clientId1, clientId2);

      await db.insert(clientGroups).values({
        id: groupId,
        name: "Test Group",
        workspace: "dfwsc_services",
        status: "active",
      });

      await db.insert(clients).values({
        id: clientId1,
        name: "Client 1",
        email: "client1@example.com",
        workspace: "dfwsc_services",
        groupId,
        stripeAccountId: "acct_1",
        status: "active",
      });

      await db.insert(clients).values({
        id: clientId2,
        name: "Client 2",
        email: "client2@example.com",
        workspace: "dfwsc_services",
        groupId,
        stripeAccountId: "acct_2",
        status: "active",
      });

      mockPaymentIntentsList
        .mockResolvedValueOnce({ data: [{ id: "pi_1", amount: 1000 }], has_more: false })
        .mockResolvedValueOnce({ data: [{ id: "pi_2", amount: 2000 }], has_more: false });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&groupId=${groupId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.groupId).toBe(groupId);
      expect(body.data).toHaveLength(2);
    });

    it("returns 404 when group does not exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&groupId=${randomUUID()}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Group not found.");
    });

    it("returns 400 when group does not belong to workspace", async () => {
      const groupId = randomUUID();
      cleanupGroupIds.push(groupId);

      await db.insert(clientGroups).values({
        id: groupId,
        name: "Test Group",
        workspace: "client_portal",
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&groupId=${groupId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("groupId does not belong to the selected workspace.");
    });

    it("returns empty array when group has no connected clients", async () => {
      const groupId = randomUUID();
      const clientId = randomUUID();
      cleanupGroupIds.push(groupId);
      cleanupIds.push(clientId);

      await db.insert(clientGroups).values({
        id: groupId,
        name: "Test Group",
        workspace: "dfwsc_services",
        status: "active",
      });

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace: "dfwsc_services",
        groupId,
        stripeAccountId: null,
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&groupId=${groupId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ groupId, data: [], hasMore: false });
    });

    it("fetches all payments for DFWSC workspace without clientId or groupId", async () => {
      const clientId1 = randomUUID();
      const clientId2 = randomUUID();
      cleanupIds.push(clientId1, clientId2);

      await db.insert(clients).values({
        id: clientId1,
        name: "Client 1",
        email: "client1@example.com",
        workspace: "dfwsc_services",
        stripeAccountId: "acct_1",
        status: "active",
      });

      await db.insert(clients).values({
        id: clientId2,
        name: "Client 2",
        email: "client2@example.com",
        workspace: "dfwsc_services",
        stripeAccountId: "acct_2",
        status: "active",
      });

      mockPaymentIntentsList
        .mockResolvedValueOnce({ data: [{ id: "pi_1", amount: 1000 }], has_more: false })
        .mockResolvedValueOnce({ data: [{ id: "pi_2", amount: 2000 }], has_more: false });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/reports/payments?workspace=dfwsc_services",
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.workspace).toBe("dfwsc_services");
      expect(body.data).toHaveLength(2);
    });

    it("returns empty array for DFWSC workspace with no connected clients", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace: "dfwsc_services",
        stripeAccountId: null,
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/reports/payments?workspace=dfwsc_services",
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ workspace: "dfwsc_services", data: [], hasMore: false });
    });

    it("returns 404 when client does not exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&clientId=${randomUUID()}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Client with connected account not found.");
    });

    it("returns 404 when client has no stripeAccountId", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace: "dfwsc_services",
        stripeAccountId: null,
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&clientId=${clientId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Client with connected account not found.");
    });

    it("returns 400 when client does not belong to workspace", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace: "client_portal",
        stripeAccountId: "acct_test",
        status: "active",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&clientId=${clientId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("clientId does not belong to the selected workspace.");
    });

    it("fetches payments for a specific client", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace: "dfwsc_services",
        stripeAccountId: "acct_test",
        status: "active",
      });

      mockPaymentIntentsList.mockResolvedValueOnce({
        data: [{ id: "pi_1", amount: 1000 }],
        has_more: false,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&clientId=${clientId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.clientId).toBe(clientId);
      expect(body.data).toHaveLength(1);
      expect(body.hasMore).toBe(false);
    });

    it("respects starting_after and ending_before pagination params", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Test Client",
        email: "test@example.com",
        workspace: "dfwsc_services",
        stripeAccountId: "acct_test",
        status: "active",
      });

      mockPaymentIntentsList.mockResolvedValueOnce({
        data: [{ id: "pi_2", amount: 2000 }],
        has_more: true,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/reports/payments?workspace=dfwsc_services&clientId=${clientId}&starting_after=pi_1`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(mockPaymentIntentsList).toHaveBeenCalledWith(
        expect.objectContaining({ starting_after: "pi_1" }),
        expect.anything()
      );
    });
  });
});
