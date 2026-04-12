import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";

describe("Health API Integration", () => {
  let app: any;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/health", () => {
    it("should return 200 and ok status when DB is connected", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe("ok");
      expect(body.database).toBe("connected");
      expect(body).toHaveProperty("timestamp");
    });

    it("should return 503 and error status when DB execution fails", async () => {
      // Mock db.execute to throw an error
      const originalExecute = db.execute;
      try {
        db.execute = vi.fn().mockRejectedValueOnce(new Error("DB Down"));

        const response = await app.inject({
          method: "GET",
          url: "/api/v1/health",
        });

        expect(response.statusCode).toBe(503);
        const body = response.json();
        expect(body.status).toBe("error");
        expect(body.database).toBe("disconnected");
      } finally {
        // Restore original execute
        db.execute = originalExecute;
      }
    });
  });
});
