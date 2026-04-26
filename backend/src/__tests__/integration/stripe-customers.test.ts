import { vi } from "vitest";

// Mock Stripe before importing anything else
vi.mock("../../lib/stripe", () => ({
  stripe: {
    customers: {
      list: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
    },
    subscriptions: {
      list: vi.fn(),
      update: vi.fn(),
    },
    subscriptionSchedules: {
      list: vi.fn(),
      update: vi.fn(),
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
import { TEST_JWT_SECRET } from "../helpers/constants";
import { ensureBaseEnv } from "../helpers/env";

const JWT_SECRET = process.env.JWT_SECRET || TEST_JWT_SECRET;
const mockListCustomers = stripe.customers.list as ReturnType<typeof vi.fn>;
const mockRetrieveCustomer = stripe.customers.retrieve as ReturnType<typeof vi.fn>;
const mockUpdateCustomer = stripe.customers.update as ReturnType<typeof vi.fn>;
const mockListSubscriptions = stripe.subscriptions.list as ReturnType<typeof vi.fn>;
const mockUpdateSubscription = stripe.subscriptions.update as ReturnType<typeof vi.fn>;
const mockListSchedules = stripe.subscriptionSchedules.list as ReturnType<typeof vi.fn>;
const mockUpdateSchedule = stripe.subscriptionSchedules.update as ReturnType<typeof vi.fn>;

describe("Stripe Customers API Integration", () => {
  let app: any;
  let adminToken: string;
  let cleanupIds: string[] = [];
  const workspace = "client_portal";

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
    adminToken = sign({ role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListCustomers.mockReset();
    mockRetrieveCustomer.mockReset();
    mockUpdateCustomer.mockReset();
    mockListSubscriptions.mockReset();
    mockUpdateSubscription.mockReset();
    mockListSchedules.mockReset();
    mockUpdateSchedule.mockReset();

    mockListSubscriptions.mockResolvedValue({ data: [], has_more: false });
    mockListSchedules.mockResolvedValue({ data: [], has_more: false });
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

    it("returns DFWSC reconciliation buckets for import, discrepancies, and allGood", async () => {
      const allGoodLocalId = randomUUID();
      const mismatchLocalId = randomUUID();
      const emailConflictLocalId = randomUUID();
      cleanupIds.push(allGoodLocalId, mismatchLocalId, emailConflictLocalId);

      await db.insert(clients).values({
        id: allGoodLocalId,
        name: "All Good LLC",
        email: "allgood@example.com",
        workspace: "dfwsc_services",
        stripeCustomerId: "cus_allgood",
        status: "active",
      });

      await db.insert(clients).values({
        id: mismatchLocalId,
        name: "Mismatch Co",
        email: "mismatch@example.com",
        phone: "111-111-1111",
        notes: "Local note",
        workspace: "dfwsc_services",
        stripeCustomerId: "cus_mismatch",
        status: "active",
      });

      await db.insert(clients).values({
        id: emailConflictLocalId,
        name: "Email Conflict",
        email: "conflict@example.com",
        workspace: "dfwsc_services",
        status: "active",
      });

      mockListCustomers.mockImplementation(() =>
        Promise.resolve({
          data: [
            {
              id: "cus_allgood",
              name: "All Good LLC",
              email: "allgood@example.com",
              phone: null,
              address: null,
              metadata: {},
              created: 11111,
              deleted: false,
            },
            {
              id: "cus_mismatch",
              name: "Mismatch Co",
              email: "mismatch@example.com",
              phone: "999-999-9999",
              address: null,
              metadata: { notes: "Stripe note" },
              created: 22222,
              deleted: false,
            },
            {
              id: "cus_new",
              name: "New Import",
              email: "new-import@example.com",
              phone: null,
              address: null,
              metadata: {},
              created: 33333,
              deleted: false,
            },
            {
              id: "cus_conflict",
              name: "Conflict Stripe",
              email: "conflict@example.com",
              phone: null,
              address: null,
              metadata: {},
              created: 44444,
              deleted: false,
            },
            {
              id: "cus_deleted",
              name: "Deleted",
              email: "deleted@example.com",
              phone: null,
              address: null,
              metadata: {},
              created: 55555,
              deleted: true,
            },
          ],
          has_more: false,
        })
      );

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/stripe/customers?workspace=dfwsc_services",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.toImport).toEqual([
        expect.objectContaining({
          stripeCustomerId: "cus_new",
          reason: "no-match",
        }),
      ]);

      expect(body.allGood).toEqual([
        expect.objectContaining({
          stripeCustomerId: "cus_allgood",
          localClientId: allGoodLocalId,
        }),
      ]);

      expect(body.discrepancies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stripeCustomerId: "cus_mismatch",
            localClientId: mismatchLocalId,
            differences: expect.arrayContaining([
              expect.objectContaining({ fieldName: "phone" }),
              expect.objectContaining({ fieldName: "notes" }),
            ]),
          }),
          expect.objectContaining({
            stripeCustomerId: "cus_conflict",
            localClientId: emailConflictLocalId,
            differences: [
              expect.objectContaining({
                fieldName: "stripeCustomerId",
                localValue: "(none)",
                stripeValue: "cus_conflict",
              }),
            ],
          }),
        ])
      );
    });

    it("returns 400 when workspace is missing", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/stripe/customers",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/workspace query parameter is required/i);
    });

    it("returns 500 when Stripe customer listing fails", async () => {
      mockListCustomers.mockRejectedValueOnce(new Error("stripe list failed"));

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/stripe/customers?workspace=${workspace}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe("Internal server error");
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

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Already Here",
        email: "already@example.com",
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

    it("imports directly for DFWSC workspace without onboarding/apiKey", async () => {
      const stripeCustomerId = "cus_dfwsc_import_001";

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "DFWSC Imported",
        email: "dfwsc-import@example.com",
        phone: "214-555-0101",
        address: {
          line1: "123 Main",
          line2: null,
          city: "Dallas",
          state: "TX",
          postal_code: "75001",
          country: "US",
        },
        metadata: {
          billingContactName: "Pat Billing",
          notes: "Imported from Stripe",
          defaultPaymentTermsDays: "45",
        },
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId, workspace: "dfwsc_services" },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.clientId).toBe(stripeCustomerId);
      expect(body.importedFromStripe).toBe(true);
      expect(body).not.toHaveProperty("apiKey");
      expect(body).not.toHaveProperty("onboardingToken");

      cleanupIds.push(stripeCustomerId);
      const [client] = await db.select().from(clients).where(eq(clients.id, stripeCustomerId));
      expect(client.workspace).toBe("dfwsc_services");
      expect(client.defaultPaymentTermsDays).toBe(45);
      expect(client.notes).toBe("Imported from Stripe");
    });

    it("returns 400 when import workspace is invalid", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId: "cus_any", workspace: "invalid_workspace" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/workspace is required/i);
    });

    it("returns 500 when Stripe retrieve fails during import", async () => {
      mockRetrieveCustomer.mockRejectedValueOnce(new Error("stripe retrieve failed"));

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/import-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { stripeCustomerId: "cus_failure", workspace },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe("Internal server error");
    });
  });

  describe("POST /api/v1/stripe/sync-customer", () => {
    it("syncs local and Stripe fields based on per-field resolution", async () => {
      const localClientId = randomUUID();
      const stripeCustomerId = "cus_sync_001";
      cleanupIds.push(localClientId);

      await db.insert(clients).values({
        id: localClientId,
        name: "Local Name",
        email: "local@example.com",
        phone: "111-111-1111",
        notes: "Keep local notes",
        defaultPaymentTermsDays: 15,
        workspace: "dfwsc_services",
        stripeCustomerId,
        status: "active",
      });

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Stripe Name",
        email: "stripe@example.com",
        phone: "999-999-9999",
        address: null,
        metadata: {
          notes: "Stripe note",
          defaultPaymentTermsDays: "30",
        },
        created: 12345,
        deleted: false,
      });
      mockUpdateCustomer.mockResolvedValue({ id: stripeCustomerId });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          stripeCustomerId,
          localClientId,
          workspace: "dfwsc_services",
          resolutions: [
            { fieldName: "name", source: "local" },
            { fieldName: "phone", source: "stripe" },
            { fieldName: "notes", source: "local" },
            { fieldName: "defaultPaymentTermsDays", source: "stripe" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        subscriptionsLinked: 0,
        schedulesLinked: 0,
        linkFailures: 0,
      });

      expect(mockUpdateCustomer).toHaveBeenCalledWith(stripeCustomerId, {
        name: "Local Name",
        metadata: { notes: "Keep local notes" },
      });

      const [updated] = await db.select().from(clients).where(eq(clients.id, localClientId));
      expect(updated.phone).toBe("999-999-9999");
      expect(updated.defaultPaymentTermsDays).toBe(30);
      expect(updated.name).toBe("Local Name");
      expect(updated.notes).toBe("Keep local notes");
    });

    it("returns 400 when workspace is not dfwsc_services", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId: "cus_any",
          localClientId: randomUUID(),
          workspace: "client_portal",
          resolutions: [{ fieldName: "name", source: "local" }],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/only available for direct billing workspaces/i);
    });

    it("rejects legacy ledger_crm workspace for sync", async () => {
      const localClientId = randomUUID();
      const stripeCustomerId = "cus_sync_ledger";
      cleanupIds.push(localClientId);

      await db.insert(clients).values({
        id: localClientId,
        name: "Ledger Sync",
        email: "ledger-sync@example.com",
        workspace: "dfwsc_services",
        stripeCustomerId,
        status: "active",
      });

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Ledger Sync",
        email: "ledger-sync@example.com",
        phone: null,
        address: null,
        metadata: {},
        created: 123,
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId,
          localClientId,
          workspace: "ledger_crm",
          resolutions: [{ fieldName: "name", source: "local" }],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/only available for direct billing workspaces/i);
    });

    it("returns 400 when required sync fields are missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId: "",
          localClientId: "",
          workspace: "dfwsc_services",
          resolutions: [],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/required/i);
    });

    it("returns 404 when local client does not exist", async () => {
      mockRetrieveCustomer.mockResolvedValueOnce({
        id: "cus_missing_local",
        name: "Stripe Name",
        email: "stripe@example.com",
        metadata: {},
        address: null,
        phone: null,
        created: 123,
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId: "cus_missing_local",
          localClientId: randomUUID(),
          workspace: "dfwsc_services",
          resolutions: [{ fieldName: "name", source: "stripe" }],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/local client not found/i);
    });

    it("returns 200 and skips updates for unknown resolution fields", async () => {
      const localClientId = randomUUID();
      cleanupIds.push(localClientId);

      await db.insert(clients).values({
        id: localClientId,
        name: "Local Client",
        email: "local-unknown-fields@example.com",
        workspace: "dfwsc_services",
        stripeCustomerId: "cus_sync_unknown",
        status: "active",
      });

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: "cus_sync_unknown",
        name: "Stripe Name",
        email: "stripe@example.com",
        metadata: {},
        address: null,
        phone: null,
        created: 123,
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId: "cus_sync_unknown",
          localClientId,
          workspace: "dfwsc_services",
          resolutions: [{ fieldName: "unknownField", source: "local" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        subscriptionsLinked: 0,
        schedulesLinked: 0,
        linkFailures: 0,
      });
      expect(mockUpdateCustomer).not.toHaveBeenCalled();
    });

    it("keeps local email unchanged when Stripe email is invalid", async () => {
      const localClientId = randomUUID();
      const stripeCustomerId = "cus_sync_bad_email";
      cleanupIds.push(localClientId);

      await db.insert(clients).values({
        id: localClientId,
        name: "Email Source",
        email: "local-valid@example.com",
        workspace: "dfwsc_services",
        stripeCustomerId,
        status: "active",
      });

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Stripe Bad Email",
        email: "not-an-email",
        phone: null,
        address: null,
        metadata: {},
        created: 12345,
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId,
          localClientId,
          workspace: "dfwsc_services",
          resolutions: [{ fieldName: "email", source: "stripe" }],
        },
      });

      expect(response.statusCode).toBe(200);

      const [updated] = await db.select().from(clients).where(eq(clients.id, localClientId));
      expect(updated.email).toBe("local-valid@example.com");
    });

    it("syncs address fields from local into Stripe nested address", async () => {
      const localClientId = randomUUID();
      const stripeCustomerId = "cus_sync_addr_nested";
      cleanupIds.push(localClientId);

      await db.insert(clients).values({
        id: localClientId,
        name: "Addr Local",
        email: "addr-local@example.com",
        addressLine1: "123 Main",
        city: "Dallas",
        state: "TX",
        postalCode: "75001",
        country: "US",
        workspace: "dfwsc_services",
        stripeCustomerId,
        status: "active",
      });

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Stripe Address",
        email: "stripe-address@example.com",
        phone: null,
        address: null,
        metadata: {},
        created: 12345,
        deleted: false,
      });
      mockUpdateCustomer.mockResolvedValueOnce({ id: stripeCustomerId });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId,
          localClientId,
          workspace: "dfwsc_services",
          resolutions: [
            { fieldName: "addressLine1", source: "local" },
            { fieldName: "city", source: "local" },
            { fieldName: "state", source: "local" },
            { fieldName: "postalCode", source: "local" },
            { fieldName: "country", source: "local" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockUpdateCustomer).toHaveBeenCalledWith(
        stripeCustomerId,
        expect.objectContaining({
          address: expect.objectContaining({
            line1: "123 Main",
            city: "Dallas",
            state: "TX",
            postal_code: "75001",
            country: "US",
          }),
        })
      );
    });

    it("returns 500 when Stripe update fails during sync", async () => {
      const localClientId = randomUUID();
      const stripeCustomerId = "cus_sync_update_fail";
      cleanupIds.push(localClientId);

      await db.insert(clients).values({
        id: localClientId,
        name: "Sync Fail",
        email: "sync-fail@example.com",
        workspace: "dfwsc_services",
        stripeCustomerId,
        status: "active",
      });

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Stripe Sync Fail",
        email: "stripe-sync-fail@example.com",
        phone: null,
        address: null,
        metadata: {},
        created: 12345,
        deleted: false,
      });
      mockUpdateCustomer.mockRejectedValueOnce(new Error("update failed"));

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId,
          localClientId,
          workspace: "dfwsc_services",
          resolutions: [{ fieldName: "name", source: "local" }],
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe("Internal server error");
    });

    it("syncs app metadata fields from Stripe into local client", async () => {
      const localClientId = randomUUID();
      const stripeCustomerId = "cus_sync_app_fields";
      cleanupIds.push(localClientId);

      await db.insert(clients).values({
        id: localClientId,
        name: "App Fields Local",
        email: "app-fields-local@example.com",
        billingContactName: "Old Billing",
        notes: "Old note",
        defaultPaymentTermsDays: 15,
        workspace: "dfwsc_services",
        stripeCustomerId,
        status: "active",
      });

      mockRetrieveCustomer.mockResolvedValueOnce({
        id: stripeCustomerId,
        name: "Stripe App Fields",
        email: "stripe-app-fields@example.com",
        phone: null,
        address: null,
        metadata: {
          billingContactName: "New Billing",
          notes: "New note",
          defaultPaymentTermsDays: "45",
        },
        created: 12345,
        deleted: false,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stripe/sync-customer",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          stripeCustomerId,
          localClientId,
          workspace: "dfwsc_services",
          resolutions: [
            { fieldName: "billingContactName", source: "stripe" },
            { fieldName: "notes", source: "stripe" },
            { fieldName: "defaultPaymentTermsDays", source: "stripe" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const [updated] = await db.select().from(clients).where(eq(clients.id, localClientId));
      expect(updated.billingContactName).toBe("New Billing");
      expect(updated.notes).toBe("New note");
      expect(updated.defaultPaymentTermsDays).toBe(45);
    });
  });
});
