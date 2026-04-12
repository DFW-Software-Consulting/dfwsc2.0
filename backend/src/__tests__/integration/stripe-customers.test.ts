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
import { sign } from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, onboardingTokens } from "../../db/schema";
import { stripe } from "../../lib/stripe";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-chars-long-!!!";
const mockListCustomers = stripe.customers.list as ReturnType<typeof vi.fn>;
const mockRetrieveCustomer = stripe.customers.retrieve as ReturnType<typeof vi.fn>;

describe("Stripe Customers API Integration", () => {
  let app: any;
  let adminToken: string;
  let cleanupIds: string[] = [];
  const workspace = "client_portal";

  beforeAll(async () => {
    app = await buildServer();
    adminToken = sign({ role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const id of cleanupIds) {
      await db.delete(onboardingTokens).where(eq(onboardingTokens.clientId, id));
      await db.delete(clients).where(eq(clients.id, id));
    }
    cleanupIds = [];
  });

  describe("GET /api/v1/stripe/customers", () => {
    it("should return 401 if not authenticated", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/stripe/customers",
      });
      expect(response.statusCode).toBe(401);
    });

    it("should list Stripe customers and filter out existing ones", async () => {
      const existingStripeId = "cus_existing123";
      const newStripeId = "cus_new123";

      // Insert an existing client
      const clientId = randomUUID();
      cleanupIds.push(clientId);
      await db.insert(clients).values({
        id: clientId,
        name: "Existing Client",
        email: "existing@example.com",
        workspace,
        stripeCustomerId: existingStripeId,
        status: "active",
      });

      mockListCustomers.mockResolvedValueOnce({
        data: [
          { id: existingStripeId, name: "Existing", email: "existing@example.com", created: 12345 },
          { id: newStripeId, name: "New Customer", email: "new@example.com", created: 67890 },
        ],
        has_more: false,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/stripe/customers?workspace=${workspace}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(newStripeId);
    });
  });

  describe("POST /api/v1/stripe/import-customer", () => {
    it("should return 401 if not authenticated", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        payload: { stripeCustomerId: "cus_123" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("should import a Stripe customer as a local client", async () => {
      const stripeCustomerId = "cus_import123";
      const email = "import@example.com";

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Imported Name",
        email: email,
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId, workspace },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.name).toBe("Imported Name");
      expect(body).toHaveProperty("clientId");
      expect(body).toHaveProperty("apiKey");

      cleanupIds.push(body.clientId);

      // Verify DB
      const [client] = await db.select().from(clients).where(eq(clients.id, body.clientId));
      expect(client.stripeCustomerId).toBe(stripeCustomerId);
    });

    it("should return 409 if client already exists", async () => {
      const stripeCustomerId = "cus_exists409";
      const clientId = randomUUID();
      cleanupIds.push(clientId);
      await db.insert(clients).values({
        id: clientId,
        name: "Already Here",
        email: "already@example.com",
        workspace,
        stripeCustomerId,
        status: "active",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId, workspace },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("Client already exists in the portal.");
    });

    it("should return 400 if stripeCustomerId is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { workspace },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("stripeCustomerId is required.");
    });

    it("should return 400 if groupId is invalid", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId: "cus_any", groupId: "non-existent", workspace },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid groupId.");
    });

    it("should return 400 if Stripe customer is deleted", async () => {
      const stripeCustomerId = "cus_deleted";
      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        deleted: true,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId, workspace },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Stripe customer has been deleted.");
    });

    it("should return 400 if Stripe customer has no valid email", async () => {
      const stripeCustomerId = "cus_no_email";
      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "No Email",
        email: null,
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId, workspace },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Stripe customer must have a valid email.");
    });

    it("should return 409 if a client with same email exists", async () => {
      const stripeCustomerId = "cus_new_email_collision";
      const email = "collision@example.com";
      const existingClientId = randomUUID();
      cleanupIds.push(existingClientId);

      await db.insert(clients).values({
        id: existingClientId,
        name: "Existing Email Holder",
        email: email,
        workspace,
        status: "active",
      });

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Colliding Customer",
        email: email,
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId, workspace },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("A client with this email already exists.");
    });
  });
});
