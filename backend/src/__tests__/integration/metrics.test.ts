import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";

describe("Metrics API Integration", () => {
  // biome-ignore lint/suspicious/noExplicitAny: Fastify instance type is inferred at build time.
  let app: any;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  it("returns 401 when METRICS_TOKEN is unset (fail closed)", async () => {
    delete process.env.METRICS_TOKEN;

    const response = await app.inject({ method: "GET", url: "/api/v1/metrics" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when METRICS_TOKEN is set and no Authorization header is provided", async () => {
    process.env.METRICS_TOKEN = "secret-metrics-token";

    const response = await app.inject({ method: "GET", url: "/api/v1/metrics" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the bearer token does not match (including different length)", async () => {
    process.env.METRICS_TOKEN = "secret-metrics-token";

    const wrongLength = await app.inject({
      method: "GET",
      url: "/api/v1/metrics",
      headers: { authorization: "Bearer short" },
    });
    expect(wrongLength.statusCode).toBe(401);

    const sameLengthWrong = await app.inject({
      method: "GET",
      url: "/api/v1/metrics",
      headers: { authorization: "Bearer secret-metrics-toben" },
    });
    expect(sameLengthWrong.statusCode).toBe(401);
  });

  it("returns 200 when METRICS_TOKEN is set and the correct bearer token is provided", async () => {
    process.env.METRICS_TOKEN = "secret-metrics-token";

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/metrics",
      headers: { authorization: "Bearer secret-metrics-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("dfwsc_clients_total");
  });
});
