import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";

describe("Security Headers Integration", () => {
  let app: any;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/health", () => {
    it("sets @fastify/helmet security headers", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health",
      });

      expect(response.headers["strict-transport-security"]).toBeDefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBeDefined();
    });

    it("omits Content-Security-Policy (deliberately left to the frontend's nginx config)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health",
      });

      expect(response.headers["content-security-policy"]).toBeUndefined();
    });
  });

  describe("Swagger UI (/docs)", () => {
    it("stays reachable with helmet enabled", async () => {
      const originalEnableSwagger = process.env.ENABLE_SWAGGER;
      let swaggerApp: any;
      try {
        process.env.ENABLE_SWAGGER = "true";
        swaggerApp = await buildServer();

        const response = await swaggerApp.inject({
          method: "GET",
          url: "/docs",
        });

        // Some Swagger UI configs redirect / to /docs/; accept either.
        expect([200, 302]).toContain(response.statusCode);
      } finally {
        process.env.ENABLE_SWAGGER = originalEnableSwagger;
        if (swaggerApp) {
          await swaggerApp.close();
        }
      }
    });
  });
});
