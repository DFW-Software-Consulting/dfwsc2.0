import { describe, expect, it } from "vitest";
import { buildServer } from "../app";

describe("app.ts extra coverage", () => {
  it("returns 404 for unknown routes", async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: "GET",
      url: "/non-existent-route",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found" });
    await server.close();
  });

  it("handles multiple missing required fields in schema validation", async () => {
    const server = await buildServer();
    const adminToken = require("jsonwebtoken").sign(
      { role: "admin" },
      process.env.JWT_SECRET || "test-secret-at-least-32-chars-long-!!!"
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {}, // Missing both name and email
    });

    expect(response.statusCode).toBe(400);
    // The custom formatter should join missing properties
    expect(response.json().error).toMatch(/name, email are required/);
    await server.close();
  });

  it("handles single missing required field in schema validation", async () => {
    const server = await buildServer();
    const adminToken = require("jsonwebtoken").sign(
      { role: "admin" },
      process.env.JWT_SECRET || "test-secret-at-least-32-chars-long-!!!"
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: { name: "Test" }, // Missing only email
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("email is required.");
    await server.close();
  });

  it("handles generic validation error messages from AJV", async () => {
    const server = await buildServer();
    const adminToken = require("jsonwebtoken").sign(
      { role: "admin" },
      process.env.JWT_SECRET || "test-secret-at-least-32-chars-long-!!!"
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: { name: "Test", email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/must match format "email"/);
    await server.close();
  });

  it("handles server initialization when NOT in test mode (for coverage)", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const server = await buildServer();
    expect(server).toBeDefined();

    // Check that genReqId works
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(response.headers["x-request-id"]).toBeDefined();

    await server.close();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("initializes Swagger when ENABLE_SWAGGER is true", async () => {
    const originalEnableSwagger = process.env.ENABLE_SWAGGER;
    process.env.ENABLE_SWAGGER = "true";

    const server = await buildServer();
    expect(server).toBeDefined();

    // Check if the /docs route exists (Fastify Swagger UI)
    const response = await server.inject({
      method: "GET",
      url: "/docs",
    });

    // It might be a redirect (302) to /docs/ or 200 depending on config
    expect([200, 302]).toContain(response.statusCode);

    await server.close();
    process.env.ENABLE_SWAGGER = originalEnableSwagger;
  });
});
