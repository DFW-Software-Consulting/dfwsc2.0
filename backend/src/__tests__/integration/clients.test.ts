import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";
import { MAX_FEE_PERCENT } from "../../lib/constants";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";
import { insertLegacyClient } from "../helpers/legacy-fee-rows";

describe("Clients API Integration", () => {
  let app: any;
  let cleanupIds: string[] = [];
  let cleanupGroupIds: string[] = [];
  const workspace = "client_portal";

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
        url: "/api/v1/clients?workspace=client_portal",
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

    it("returns only clients in the requested workspace", async () => {
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
      expect(body.data.some((c: any) => c.id === clientId)).toBe(true);
      expect(body.data.every((c: any) => c.workspace === workspace)).toBe(true);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
      expect(body.total).toBeGreaterThanOrEqual(1);
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
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data.some((c: any) => c.id === clientId)).toBe(true);
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
      expect(body.data.every((c: any) => c.groupId === groupId)).toBe(true);
    });

    it("paginates clients", async () => {
      const clientIds = [randomUUID(), randomUUID()];
      cleanupIds.push(...clientIds);

      await db.insert(clients).values(
        clientIds.map((id, index) => ({
          id,
          name: `Paged Client ${index}`,
          email: `paged-${index}@example.com`,
          workspace: workspace as "client_portal",
          status: "active" as const,
        }))
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients?workspace=${workspace}&limit=1&offset=0`,
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

  describe("DELETE /api/v1/clients/:id", () => {
    it("archives a client and excludes it from client list", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Delete Me",
        email: "delete-me@example.com",
        workspace,
        status: "active",
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/clients/${clientId}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(deleteResponse.statusCode).toBe(204);
      const [archived] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      expect(archived.status).toBe("archived");

      const listResponse = await app.inject({
        method: "GET",
        url: `/api/v1/clients?workspace=${workspace}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(listResponse.json().data.some((c: any) => c.id === clientId)).toBe(false);
    });

    it("returns 404 when client does not exist", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/clients/${randomUUID()}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Client not found.");
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

    it("normalizes and stores connectRedirectOrigins, rejecting non-origins", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);
      await db.insert(clients).values({
        id: clientId,
        name: "Origins Client",
        email: `origins-${clientId}@example.com`,
        workspace,
        status: "active",
      });
      const patch = (connectRedirectOrigins: string[]) =>
        app.inject({
          method: "PATCH",
          url: `/api/v1/clients/${clientId}`,
          headers: {
            authorization: `Bearer ${makeAdminToken()}`,
            "content-type": "application/json",
          },
          payload: { connectRedirectOrigins },
        });

      const ok = await patch(["https://App.Example.com", "https://app.example.com:443"]);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().connectRedirectOrigins).toEqual(["https://app.example.com"]);

      for (const bad of ["https://app.example.com/path", "http://app.example.com", "not a url"]) {
        expect((await patch([bad])).statusCode).toBe(400);
      }
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

    it("returns 400 when processingFeeCents exceeds the int4 maximum", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Fee Cap Client",
        email: `${clientId}@example.com`,
        status: "active",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { processingFeeCents: 2147483648 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("processingFeeCents must be at most 2147483647.");
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

    it("returns 400 when name is empty", async () => {
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
        payload: { name: "   " },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/name must not be empty/i);
    });

    it("returns 400 when email format is invalid", async () => {
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
        payload: { email: "not-an-email" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/email must be a valid email/i);
    });

    it("returns 409 when email conflicts with another client in same workspace", async () => {
      const clientId1 = randomUUID();
      const clientId2 = randomUUID();
      cleanupIds.push(clientId1, clientId2);

      await db.insert(clients).values([
        {
          id: clientId1,
          name: "Client One",
          email: "one@example.com",
          workspace,
          status: "active",
        },
        {
          id: clientId2,
          name: "Client Two",
          email: "two@example.com",
          workspace,
          status: "active",
        },
      ]);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId1}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { email: "two@example.com" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe(
        "A client with this email already exists in this workspace."
      );
    });

    it("returns 400 when defaultPaymentTermsDays is not a positive integer", async () => {
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
        payload: { defaultPaymentTermsDays: -5 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/defaultPaymentTermsDays must be a positive integer/i);
    });

    it("successfully updates profile fields (name, phone, address)", async () => {
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
          name: "Updated Corp",
          phone: "+1 (555) 000-1234",
          addressLine1: "456 Oak Ave",
          city: "Dallas",
          state: "TX",
          postalCode: "75201",
          country: "US",
          defaultPaymentTermsDays: 30,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe("Updated Corp");
      expect(body.phone).toBe("+1 (555) 000-1234");
      expect(body.addressLine1).toBe("456 Oak Ave");
      expect(body.city).toBe("Dallas");
      expect(body.defaultPaymentTermsDays).toBe(30);
    });
  });

  describe("PATCH /api/v1/clients/:id invoicingEnabled", () => {
    async function insertClient() {
      const clientId = randomUUID();
      cleanupIds.push(clientId);
      await db.insert(clients).values({
        id: clientId,
        name: "Invoicing Client",
        email: `invoicing-${clientId}@example.com`,
        workspace,
        status: "active",
      });
      return clientId;
    }

    const patch = (clientId: string, payload: unknown) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload,
      });

    it("defaults to false and lets an admin toggle it on and off", async () => {
      const clientId = await insertClient();
      const [initial] = await db.select().from(clients).where(eq(clients.id, clientId));
      expect(initial.invoicingEnabled).toBe(false);

      const on = await patch(clientId, { invoicingEnabled: true });
      expect(on.statusCode).toBe(200);
      expect(on.json().invoicingEnabled).toBe(true);
      const [afterOn] = await db.select().from(clients).where(eq(clients.id, clientId));
      expect(afterOn.invoicingEnabled).toBe(true);

      const off = await patch(clientId, { invoicingEnabled: false });
      expect(off.statusCode).toBe(200);
      expect(off.json().invoicingEnabled).toBe(false);
    });

    it("leaves the flag unchanged when it is not in the body", async () => {
      const clientId = await insertClient();
      await patch(clientId, { invoicingEnabled: true });
      const res = await patch(clientId, { notes: "unrelated" });
      expect(res.statusCode).toBe(200);
      expect(res.json().invoicingEnabled).toBe(true);
    });

    it.each(["true", 1, null, "yes"])("rejects non-boolean input %j", async (value) => {
      const clientId = await insertClient();
      const res = await patch(clientId, { invoicingEnabled: value });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/invoicingEnabled/);
      const [row] = await db.select().from(clients).where(eq(clients.id, clientId));
      expect(row.invoicingEnabled).toBe(false);
    });

    it("rejects an invalid bearer token with 401", async () => {
      const clientId = await insertClient();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
        payload: { invoicingEnabled: true },
      });
      expect(res.statusCode).toBe(401);
      const [row] = await db.select().from(clients).where(eq(clients.id, clientId));
      expect(row.invoicingEnabled).toBe(false);
    });

    it("requires admin auth", async () => {
      const clientId = await insertClient();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${clientId}`,
        headers: { "content-type": "application/json" },
        payload: { invoicingEnabled: true },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("PATCH /api/v1/clients/:id fee clearing", () => {
    async function seed(fees: { processingFeePercent?: string; processingFeeCents?: number }) {
      const id = randomUUID();
      cleanupIds.push(id);
      const row = {
        id,
        name: "Fee Client",
        email: `fee-${id}@example.com`,
        workspace,
        status: "active",
        ...fees,
      } as const;
      // Both fee types set is a legacy state the CHECKs (migration 0042) reject on new writes.
      if (fees.processingFeePercent && fees.processingFeeCents) await insertLegacyClient(row);
      else await db.insert(clients).values(row);
      return id;
    }

    const patch = (id: string, payload: unknown) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/clients/${id}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload,
      });

    const stored = async (id: string) => {
      const [row] = await db.select().from(clients).where(eq(clients.id, id));
      return { percent: row.processingFeePercent, cents: row.processingFeeCents };
    };

    it("stores a percent and nulls the stored cents", async () => {
      const id = await seed({ processingFeeCents: 100 });
      const res = await patch(id, { processingFeePercent: 2.5 });
      expect(res.statusCode).toBe(200);
      const row = await stored(id);
      expect(Number(row.percent)).toBeCloseTo(2.5);
      expect(typeof row.percent).toBe("string");
      expect(row.cents).toBeNull();
    });

    it("stores cents and nulls the stored percent", async () => {
      const id = await seed({ processingFeePercent: "3" });
      const res = await patch(id, { processingFeeCents: 250 });
      expect(res.statusCode).toBe(200);
      const row = await stored(id);
      expect(row.cents).toBe(250);
      expect(row.percent).toBeNull();
    });

    it("clearing percent leaves stored cents unchanged", async () => {
      const id = await seed({ processingFeePercent: "3", processingFeeCents: 100 });
      const res = await patch(id, { processingFeePercent: null });
      expect(res.statusCode).toBe(200);
      const row = await stored(id);
      expect(row.percent).toBeNull();
      expect(row.cents).toBe(100);
    });

    it("clearing cents leaves stored percent unchanged", async () => {
      const id = await seed({ processingFeePercent: "3", processingFeeCents: 100 });
      const res = await patch(id, { processingFeeCents: null });
      expect(res.statusCode).toBe(200);
      const row = await stored(id);
      expect(row.cents).toBeNull();
      expect(Number(row.percent)).toBeCloseTo(3);
    });

    it("leaves the stored fee unchanged when neither is in the body", async () => {
      const id = await seed({ processingFeePercent: "3" });
      const before = await stored(id);
      const res = await patch(id, { notes: "unrelated" });
      expect(res.statusCode).toBe(200);
      expect(await stored(id)).toEqual(before);
    });
  });

  describe("GET /api/v1/clients/:id", () => {
    it("returns 401 if not authenticated", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients/${randomUUID()}?workspace=${workspace}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns 400 when workspace is missing", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients/${randomUUID()}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/workspace query parameter is required/i);
    });

    it("returns 404 when client does not exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients/${randomUUID()}?workspace=${workspace}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Client not found.");
    });

    it("returns all client fields on success", async () => {
      const clientId = randomUUID();
      cleanupIds.push(clientId);

      await db.insert(clients).values({
        id: clientId,
        name: "Full Client",
        email: "full@example.com",
        workspace,
        status: "active",
        phone: "+1 (555) 123-4567",
        billingContactName: "Jane Doe",
        addressLine1: "123 Main St",
        city: "Dallas",
        state: "TX",
        postalCode: "75201",
        country: "US",
        notes: "VIP client",
        defaultPaymentTermsDays: 45,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients/${clientId}?workspace=${workspace}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const { client } = response.json();
      expect(client.id).toBe(clientId);
      expect(client.name).toBe("Full Client");
      expect(client.phone).toBe("+1 (555) 123-4567");
      expect(client.billingContactName).toBe("Jane Doe");
      expect(client.addressLine1).toBe("123 Main St");
      expect(client.city).toBe("Dallas");
      expect(client.defaultPaymentTermsDays).toBe(45);
      expect(client.createdAt).toBeDefined();
      expect(client.updatedAt).toBeDefined();
    });
  });

  describe("Admin validation responses (pinned)", () => {
    const patchUrl = "/api/v1/clients/client-validation-only";
    const feePercentMax = `processingFeePercent must be greater than 0 and at most ${MAX_FEE_PERCENT}.`;
    const NAME_TYPE_ERROR = "Invalid input: expected string, received number";
    const PAGINATION_ERROR =
      "limit must be an integer between 1 and 100 and offset must be a non-negative integer.";

    const patch = (payload: unknown) =>
      app.inject({
        method: "PATCH",
        url: patchUrl,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload,
      });

    it.each([
      ["limit=0"],
      ["limit=101"],
      ["limit=abc"],
      ["limit=1.5"],
      ["offset=-1"],
      ["offset=1.5"],
      ["offset=abc"],
    ])("GET list with %s returns 400 with only an error key", async (qs) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/clients?workspace=client_portal&${qs}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: PAGINATION_ERROR });
    });

    it.each([
      [
        "both fee types",
        { processingFeePercent: 5, processingFeeCents: 100 },
        "Set one fee type, not both.",
      ],
      ["percent above max", { processingFeePercent: MAX_FEE_PERCENT + 1 }, feePercentMax],
      ["percent zero", { processingFeePercent: 0 }, feePercentMax],
      ["percent negative", { processingFeePercent: -1 }, feePercentMax],
      [
        "cents negative",
        { processingFeeCents: -1 },
        "processingFeeCents must be a non-negative integer.",
      ],
      [
        "cents fractional",
        { processingFeeCents: 1.5 },
        "processingFeeCents must be a non-negative integer.",
      ],
      [
        "success URL http",
        { paymentSuccessUrl: "http://example.com/ok" },
        "paymentSuccessUrl must be a valid HTTPS URL.",
      ],
      [
        "success URL garbage",
        { paymentSuccessUrl: "not a url" },
        "paymentSuccessUrl must be a valid HTTPS URL.",
      ],
      [
        "cancel URL http",
        { paymentCancelUrl: "http://example.com/no" },
        "paymentCancelUrl must be a valid HTTPS URL.",
      ],
      [
        "cancel URL garbage",
        { paymentCancelUrl: "nope" },
        "paymentCancelUrl must be a valid HTTPS URL.",
      ],
      [
        "invalid status",
        { status: "archived" },
        'Invalid status value. Must be "active" or "inactive".',
      ],
      [
        "status beats refinements",
        { status: "bogus", paymentSuccessUrl: "http://x.test", processingFeeCents: -1 },
        'Invalid status value. Must be "active" or "inactive".',
      ],
      ["name empty", { name: "" }, "name must not be empty."],
      ["name whitespace", { name: "   " }, "name must not be empty."],
      ["name not a string", { name: 123 }, NAME_TYPE_ERROR],
    ])("PATCH rejects %s with the exact 400 body", async (_label, payload, message) => {
      const response = await patch(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: message });
    });

    it.each([
      [
        "URL beats fee",
        { processingFeeCents: -1, paymentSuccessUrl: "http://x.test" },
        "paymentSuccessUrl must be a valid HTTPS URL.",
      ],
      [
        "URL beats name",
        { name: "", paymentCancelUrl: "nope" },
        "paymentCancelUrl must be a valid HTTPS URL.",
      ],
      [
        "fee beats name",
        { name: "", processingFeeCents: -1 },
        "processingFeeCents must be a non-negative integer.",
      ],
      [
        "fee beats email",
        { email: "bad", processingFeeCents: -1 },
        "processingFeeCents must be a non-negative integer.",
      ],
      [
        "both-fees beats percent range",
        { processingFeePercent: 500, processingFeeCents: 100 },
        "Set one fee type, not both.",
      ],
      [
        "both-fees beats cents range",
        { processingFeePercent: 5, processingFeeCents: -1 },
        "Set one fee type, not both.",
      ],
      [
        "success URL beats cancel URL",
        { paymentSuccessUrl: "http://x.test", paymentCancelUrl: "nope" },
        "paymentSuccessUrl must be a valid HTTPS URL.",
      ],
    ])("PATCH validation order: %s", async (_label, payload, message) => {
      const response = await patch(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: message });
    });
  });
});
