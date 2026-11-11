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
import { MAX_FEE_PERCENT } from "../../lib/constants";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";
import { insertLegacyGroup } from "../helpers/legacy-fee-rows";

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
          workspace: workspace as "client_portal",
          status: "active" as const,
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

  describe("PATCH /api/v1/groups/:id fee clearing", () => {
    async function seed(fees: { processingFeePercent?: string; processingFeeCents?: number }) {
      const id = randomUUID();
      createdGroupIds.push(id);
      const row = { id, name: `Fee Group ${id}`, workspace, ...fees } as const;
      // Both fee types set is a legacy state the CHECKs (migration 0042) reject on new writes.
      if (fees.processingFeePercent && fees.processingFeeCents) await insertLegacyGroup(row);
      else await db.insert(clientGroups).values(row);
      return id;
    }

    const patch = (id: string, payload: unknown) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${id}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload,
      });

    const stored = async (id: string) => {
      const [row] = await db.select().from(clientGroups).where(eq(clientGroups.id, id));
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
      const res = await patch(id, { name: "Renamed Fee Group" });
      expect(res.statusCode).toBe(200);
      expect(await stored(id)).toEqual(before);
    });
  });

  describe("Admin validation responses (pinned)", () => {
    const patchUrl = "/api/v1/groups/grp-validation-only";
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
        url: `/api/v1/groups?workspace=client_portal&${qs}`,
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
      ["name empty", { name: "" }, "name must be a non-empty string."],
      ["name whitespace", { name: "   " }, "name must be a non-empty string."],
      ["name not a string", { name: 123 }, NAME_TYPE_ERROR],
    ])("PATCH rejects %s with the exact 400 body", async (_label, payload, message) => {
      const response = await patch(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: message });
    });

    it.each([
      [
        "name beats fee and URL",
        { name: "", processingFeeCents: -1, paymentSuccessUrl: "http://x.test" },
        "name must be a non-empty string.",
      ],
      [
        "fee beats URL",
        { processingFeeCents: -1, paymentSuccessUrl: "http://x.test" },
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

    it("PATCH trims the name before saving it", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/groups",
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { name: "Trim Target", workspace },
      });
      const id = created.json().id;
      createdGroupIds.push(id);
      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${id}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload: { name: "  Trimmed Name  " },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe("Trimmed Name");
    });

    it.each([
      ["missing", ""],
      ["invalid", "?workspace=other"],
    ])("GET with %s workspace returns 400 through the global error handler", async (_l, qs) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/groups${qs}`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "workspace query parameter is required (client_portal).",
        code: expect.any(String),
        requestId: expect.any(String),
      });
    });
  });
});
