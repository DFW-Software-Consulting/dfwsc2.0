import { eq } from "drizzle-orm";
import { sign } from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { settings } from "../../db/schema";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-chars-long-!!!";

describe("Settings API Integration", () => {
  let app: any;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildServer();
    adminToken = sign({ role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  });

  afterAll(async () => {
    await app.close();
    // Clean up settings modified during tests
    await db.delete(settings).where(eq(settings.key, "company_name"));
    await db.delete(settings).where(eq(settings.key, "contact_email"));
    await db.delete(settings).where(eq(settings.key, "default_fee_cents"));
    await db.delete(settings).where(eq(settings.key, "default_fee_percent"));
  });

  describe("GET /api/v1/settings", () => {
    it("should return 401 if not authenticated", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/settings",
      });
      expect(response.statusCode).toBe(401);
    });

    it("should return settings for admin", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/settings",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("companyName");
      expect(body).toHaveProperty("contactEmail");
      expect(body).toHaveProperty("defaultFeeCents");
    });
  });

  describe("PATCH /api/v1/settings/:key", () => {
    it("should return 401 if not authenticated", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/company_name",
        payload: { value: "New Company Name" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("should update company_name", async () => {
      const newValue = "Test Corp " + Math.random().toString(36).substring(7);
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/company_name",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { value: newValue },
      });
      expect(response.statusCode).toBe(200);

      // Verify via GET
      const getResponse = await app.inject({
        method: "GET",
        url: "/api/v1/settings",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(getResponse.json().companyName).toBe(newValue);
    });

    it("should return 400 for invalid key", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/invalid_key",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { value: "some value" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid setting key.");
    });

    it("should validate default_fee_cents", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/default_fee_cents",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { value: "abc" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Fee in cents must be a non-negative integer.");
    });

    it("should validate default_fee_percent", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/default_fee_percent",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { value: "150" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Fee percent must be between 0 and 100.");
    });

    it("should validate contact_email", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/contact_email",
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: { value: "not-an-email" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Contact email must be a valid email address.");
    });
  });
});
