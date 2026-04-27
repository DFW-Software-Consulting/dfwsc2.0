import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients } from "../../db/schema";
import { ensureBaseEnv } from "../helpers/env";
import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "test_jwt_secret_minimum_32_characters_long_random_string";

function makeAdminToken() {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

describe("CRM Clients API", () => {
  let app: any;
  let cleanupIds: string[] = [];
  const headers = { "Content-Type": "application/json" };

  beforeAll(async () => {
    ensureBaseEnv();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    app = await buildServer();
  });

  afterEach(async () => {
    for (const id of cleanupIds) {
      await db.delete(clients).where(eq(clients.id, id));
    }
    cleanupIds = [];
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a DFWSC client", async () => {
    const token = makeAdminToken(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/crm/clients",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      payload: { name: "Test Client", email: "test@example.com", phone: "+1 555-0100" },
    });

    expect(res.statusCode).toBe(201);
    const json = JSON.parse(res.payload);
    expect(json).toMatchObject({
      name: "Test Client",
      email: "test@example.com",
      workspace: "dfwsc",
    });
    expect(json.id).toMatch(/^client_/);
    if (json.id) cleanupIds.push(json.id);
  });

  it("returns 400 for missing name", async () => {
    const token = makeAdminToken(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/crm/clients",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      payload: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.payload);
    expect(json.error).toBe("name is required");
  });

  it("returns 400 for missing email", async () => {
    const token = makeAdminToken(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/crm/clients",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      payload: { name: "Test Client" },
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.payload);
    expect(json.error).toBe("email is required");
  });

  it("returns 400 for invalid email", async () => {
    const token = makeAdminToken(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/crm/clients",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      payload: { name: "Test Client", email: "not-an-email" },
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.payload);
    expect(json.error).toBe("valid email is required");
  });

  it("returns 409 for duplicate email", async () => {
    const token = makeAdminToken(app);

    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/crm/clients",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      payload: { name: "First Client", email: "duplicate@example.com" },
    });
    const json1 = JSON.parse(res1.payload);
    if (json1.id) cleanupIds.push(json1.id);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/crm/clients",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      payload: { name: "Second Client", email: "duplicate@example.com" },
    });

    expect(res2.statusCode).toBe(409);
    const json2 = JSON.parse(res2.payload);
    expect(json2.error).toBe("A client with this email already exists");
  });

  it("lists DFWSC clients", async () => {
    const token = makeAdminToken(app);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/crm/clients",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      payload: { name: "List Test Client", email: "listtest@example.com" },
    });
    const createJson = JSON.parse(createRes.payload);
    if (createJson.id) cleanupIds.push(createJson.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/crm/clients",
      headers: { ...headers, Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.payload);
    expect(Array.isArray(json)).toBe(true);
    expect(json.some((c: { email: string }) => c.email === "listtest@example.com")).toBe(true);
  });

  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/crm/clients",
      headers,
    });

    expect(res.statusCode).toBe(401);
  });
});