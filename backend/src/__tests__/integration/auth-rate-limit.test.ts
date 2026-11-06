import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { AUTH_RATE_LIMIT_MAX } from "../../lib/constants";
import { hitBuckets } from "../../lib/rate-limit";
import { ensureBaseEnv } from "../helpers/env";

// Rate limiting runs before any Nextcloud call. With Nextcloud unconfigured every admitted
// request ends in 503; a refused one is 429.
const login = (app: Awaited<ReturnType<typeof buildServer>>, remoteAddress = "198.51.100.1") =>
  app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "test", password: "test" },
    headers: { "content-type": "application/json" },
    remoteAddress,
  });

describe("Auth Rate Limit Integration", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    ensureBaseEnv();
    for (const key of ["NEXTCLOUD_BASE_URL", "NEXTCLOUD_USERNAME", "NEXTCLOUD_APP_PASSWORD"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    hitBuckets.clear();
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    hitBuckets.clear();
  });

  it("allows requests up to the limit, then blocks with 429 and Retry-After", async () => {
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i++) {
      expect((await login(app)).statusCode).toBe(503);
    }

    const blocked = await login(app);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("allows requests again after the window resets", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_000_000;
    nowSpy.mockImplementation(() => now);

    for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i++) {
      expect((await login(app)).statusCode).toBe(503);
    }
    expect((await login(app)).statusCode).toBe(429);

    now += 15 * 60 * 1000 + 1;

    expect((await login(app)).statusCode).toBe(503);
  });

  it("tracks the limit per IP address", async () => {
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i++) await login(app, "198.51.100.1");
    expect((await login(app, "198.51.100.1")).statusCode).toBe(429);

    expect((await login(app, "198.51.100.2")).statusCode).toBe(503);
  });
});
