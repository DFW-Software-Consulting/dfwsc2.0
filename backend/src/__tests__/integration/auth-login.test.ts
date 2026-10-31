import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { parseAdminGroups } from "../../lib/admin-login";
import { AUTH_RATE_LIMIT_MAX, AUTH_USER_RATE_LIMIT_MAX } from "../../lib/constants";
import {
  getNextcloudBreakerState,
  openNextcloudBreakerForTests,
  resetNextcloudBreakerForTests,
} from "../../lib/nextcloud";
import { hitBuckets } from "../../lib/rate-limit";
import authRoutes from "../../routes/auth";
import { TEST_JWT_SECRET } from "../helpers/constants";
import { ensureBaseEnv } from "../helpers/env";
import {
  FakeLoginNextcloud,
  LOGIN_NC_BASE,
  LOGIN_NC_SERVICE_USER,
  loginEnv,
} from "../helpers/fake-nextcloud-login";

const LOGIN = "/api/v1/auth/login";
const PASSWORD = "Hunter2-Sup3r-Secret-pw";

let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

describe("POST /auth/login (Nextcloud)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let fake: FakeLoginNextcloud;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(values: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in savedEnv)) savedEnv[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const login = (
    payload: unknown,
    remoteAddress: string = nextIp(),
    extra: Record<string, unknown> = {}
  ) =>
    app.inject({
      method: "POST",
      url: LOGIN,
      payload: payload as any,
      headers: { "content-type": "application/json" },
      remoteAddress,
      ...extra,
    });

  beforeEach(async () => {
    ensureBaseEnv();
    setEnv({ ...loginEnv(), ADMIN_NEXTCLOUD_GROUPS: undefined });
    hitBuckets.clear();
    resetNextcloudBreakerForTests();
    fake = new FakeLoginNextcloud();
    fake.addUser("jane", PASSWORD, ["staff", "dfwsc-admins"], ["jane@example.com"]);
    fake.addUser("mgr", PASSWORD, ["managers"]);
    fake.addUser("intern", PASSWORD, ["staff"]);
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    hitBuckets.clear();
  });

  describe("success", () => {
    it("issues an admin JWT with the Nextcloud user id as sub when the user is in the first group", async () => {
      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.expiresIn).toBe("1h");
      expect(body).not.toHaveProperty("bootstrapPending");
      const decoded = jwt.verify(body.token, process.env.JWT_SECRET as string) as jwt.JwtPayload;
      expect(decoded).toMatchObject({ role: "admin", sub: "jane" });
      expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
    });

    it("accepts membership of any listed group, not only the first", async () => {
      const res = await login({ username: "mgr", password: PASSWORD });

      expect(res.statusCode).toBe(200);
      expect(jwt.decode(res.json().token)).toMatchObject({ sub: "mgr" });
    });

    it("takes the canonical user id from Nextcloud when the user typed an alias", async () => {
      const res = await login({ username: "jane@example.com", password: PASSWORD });

      expect(res.statusCode).toBe(200);
      expect(jwt.decode(res.json().token)).toMatchObject({ sub: "jane" });
      expect(fake.groupChecks[0].path).toBe("/ocs/v2.php/cloud/users/jane/groups?format=json");
    });

    it("honours JWT_EXPIRY", async () => {
      setEnv({ JWT_EXPIRY: "2h" });
      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.json().expiresIn).toBe("2h");
      setEnv({ JWT_EXPIRY: "1h" });
    });

    it("uses ADMIN_NEXTCLOUD_GROUPS when set, ignoring the defaults", async () => {
      setEnv({ ADMIN_NEXTCLOUD_GROUPS: " ops , staff " });

      expect((await login({ username: "intern", password: PASSWORD })).statusCode).toBe(200);
      expect((await login({ username: "jane", password: PASSWORD })).statusCode).toBe(200);
      expect((await login({ username: "mgr", password: PASSWORD })).statusCode).toBe(403);
    });

    it("trims the submitted username", async () => {
      const res = await login({ username: "  jane  ", password: PASSWORD });

      expect(res.statusCode).toBe(200);
      expect(fake.userChecks[0].user).toBe("jane");
    });

    it("calls Nextcloud with the OCS header, the user's credentials, then the service account", async () => {
      await login({ username: "jane", password: PASSWORD });

      expect(fake.requests).toHaveLength(2);
      const [user, groups] = fake.requests;
      expect(user).toMatchObject({
        method: "GET",
        host: "cloud.test",
        path: "/ocs/v2.php/cloud/user?format=json",
        user: "jane",
        password: PASSWORD,
        ocsHeader: "true",
      });
      expect(groups).toMatchObject({
        method: "GET",
        host: "cloud.test",
        user: LOGIN_NC_SERVICE_USER,
        ocsHeader: "true",
      });
      expect(groups.password).not.toBe(PASSWORD);
    });
  });

  describe("refusals", () => {
    it("answers the generic 401 for a wrong password, without checking groups", async () => {
      const res = await login({ username: "jane", password: "wrong" });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("Invalid credentials");
      expect(fake.groupChecks).toHaveLength(0);
    });

    it("answers the same 401 for an unknown user", async () => {
      const res = await login({ username: "nobody", password: PASSWORD });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("Invalid credentials");
    });

    it("answers 403 for valid credentials outside every allowed group", async () => {
      const res = await login({ username: "intern", password: PASSWORD });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("This Nextcloud account isn't authorized for the admin panel");
      expect(res.json()).not.toHaveProperty("token");
    });

    it("answers 403 for a user with no groups at all", async () => {
      fake.addUser("lonely", PASSWORD, []);

      expect((await login({ username: "lonely", password: PASSWORD })).statusCode).toBe(403);
    });

    it("matches group ids exactly (case-sensitive)", async () => {
      fake.addUser("shouty", PASSWORD, ["DFWSC-ADMINS", "Managers"]);

      expect((await login({ username: "shouty", password: PASSWORD })).statusCode).toBe(403);
    });

    it("answers 400 for a missing field and calls Nextcloud for nothing", async () => {
      expect((await login({ username: "jane" })).statusCode).toBe(400);
      expect((await login({ password: PASSWORD })).statusCode).toBe(400);
      expect((await login({ username: "", password: "" })).statusCode).toBe(400);
      expect(fake.requests).toHaveLength(0);
    });

    it("refuses a username with ':' or a control character without calling Nextcloud", async () => {
      expect((await login({ username: "jane:x", password: PASSWORD })).statusCode).toBe(401);
      expect((await login({ username: "ja\nne", password: PASSWORD })).statusCode).toBe(401);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("Nextcloud trouble is 503, never 500", () => {
    const unavailable = { error: "Admin login is unavailable" };

    it("when the user check answers 5xx", async () => {
      fake.fail({ match: (r) => r.path.startsWith("/ocs/v2.php/cloud/user?"), status: 500 });
      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject(unavailable);
    });

    it("when the group check answers 5xx", async () => {
      fake.fail({ match: (r) => r.path.includes("/groups"), status: 502 });
      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject(unavailable);
    });

    it("when the request times out", async () => {
      fake.fail({ match: () => true, timeout: true });
      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject(unavailable);
    });

    it("when the connection fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        })
      );
      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.statusCode).toBe(503);
    });

    it("when the service account is refused (401) on the group check", async () => {
      setEnv({ NEXTCLOUD_APP_PASSWORD: "revoked-app-password" });
      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.statusCode).toBe(503);
    });

    it("when Nextcloud throttles the caller (429)", async () => {
      fake.fail({ match: (r) => r.path.startsWith("/ocs/v2.php/cloud/user?"), status: 429 });

      expect((await login({ username: "jane", password: PASSWORD })).statusCode).toBe(503);
    });

    it("when Nextcloud answers something unreadable", async () => {
      fake.userBodyOverride = "<html>maintenance</html>";

      expect((await login({ username: "jane", password: PASSWORD })).statusCode).toBe(503);
    });

    it.each([
      ["unset", { NEXTCLOUD_BASE_URL: undefined }],
      ["missing a username", { NEXTCLOUD_USERNAME: undefined }],
      ["missing an app password", { NEXTCLOUD_APP_PASSWORD: undefined }],
      ["not HTTPS", { NEXTCLOUD_BASE_URL: "http://cloud.test" }],
    ])("when Nextcloud is not configured (%s), without calling anything", async (_name, env) => {
      setEnv(env);
      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject(unavailable);
      expect(fake.requests).toHaveLength(0);
    });

    it("fails fast with 503 while the breaker is open, without calling Nextcloud", async () => {
      openNextcloudBreakerForTests();

      const res = await login({ username: "jane", password: PASSWORD });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject(unavailable);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("the circuit breaker", () => {
    it("does not count users' wrong passwords (401) as failures", async () => {
      // The breaker's counters are cumulative across tests, so compare against a baseline.
      const before = getNextcloudBreakerState().failures;
      for (let i = 0; i < AUTH_RATE_LIMIT_MAX * 4; i++) {
        const res = await login({ username: `ghost${i}`, password: "wrong" });
        expect(res.statusCode).toBe(401);
      }

      expect(getNextcloudBreakerState()).toMatchObject({ open: false, failures: before });
      expect((await login({ username: "jane", password: PASSWORD })).statusCode).toBe(200);
    });

    it("does not count a user's 403 from Nextcloud either", async () => {
      fake.fail({ match: (r) => r.path.startsWith("/ocs/v2.php/cloud/user?"), status: 403 });
      const before = getNextcloudBreakerState().failures;
      for (let i = 0; i < 12; i++) {
        expect((await login({ username: `u${i}`, password: PASSWORD })).statusCode).toBe(401);
      }

      expect(getNextcloudBreakerState()).toMatchObject({ open: false, failures: before });
    });
  });

  describe("rate limits", () => {
    it("limits per client IP", async () => {
      const ip = "198.51.100.7";
      for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i++) {
        const res = await login({ username: `user${i}`, password: "x" }, ip);
        expect(res.statusCode).toBe(401);
      }

      const blocked = await login({ username: "user-next", password: "x" }, ip);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
      expect(blocked.headers["retry-after"]).toBeDefined();

      const otherIp = await login({ username: "user-next", password: "x" }, "198.51.100.8");
      expect(otherIp.statusCode).toBe(401);
    });

    it("limits per username across IPs, ignoring case and surrounding spaces", async () => {
      const spellings = ["Jane", "jane", " JANE ", "jane"];
      for (let i = 0; i < AUTH_USER_RATE_LIMIT_MAX; i++) {
        const res = await login({ username: spellings[i % spellings.length], password: "x" });
        expect(res.statusCode).toBe(401);
      }

      const blocked = await login({ username: "jane", password: PASSWORD });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
      // The refused request never reached Nextcloud.
      expect(fake.userChecks).toHaveLength(AUTH_USER_RATE_LIMIT_MAX);

      expect((await login({ username: "mgr", password: PASSWORD })).statusCode).toBe(200);
    });

    it("keeps the per-username bucket under its own key, with a hashed username", async () => {
      await login({ username: "jane", password: "x" });

      const keys = [...hitBuckets.keys()];
      expect(keys.some((k) => k.startsWith("ratelimit:POST:/api/v1/auth/login:"))).toBe(true);
      expect(keys.some((k) => k.startsWith("ratelimit:POST:/auth/login:username:"))).toBe(true);
      expect(keys.some((k) => k.includes("jane"))).toBe(false);
    });
  });

  describe("endpoint encoding", () => {
    it("percent-encodes the user id in the group lookup", async () => {
      const odd = "o'brien/ops team+1@ex ample.com";
      fake.addUser(odd, PASSWORD, ["managers"]);

      const res = await login({ username: odd, password: PASSWORD });

      expect(res.statusCode).toBe(200);
      expect(jwt.decode(res.json().token)).toMatchObject({ sub: odd });
      const groups = fake.groupChecks[0];
      expect(groups.rawPath).toBe(
        `/ocs/v2.php/cloud/users/${encodeURIComponent(odd)}/groups?format=json`
      );
      expect(groups.rawPath).not.toContain(" ");
      expect(groups.rawPath.split("?")[0].split("/")).toHaveLength(7);
    });
  });

  describe("secrets", () => {
    it("sends the password only to NEXTCLOUD_BASE_URL, and only on the user check", async () => {
      await login({ username: "jane", password: PASSWORD });
      await login({ username: "jane", password: "wrong" });

      expect(new URL(LOGIN_NC_BASE).host).toBe("cloud.test");
      for (const req of fake.requests) expect(req.host).toBe("cloud.test");
      for (const req of fake.groupChecks) expect(req.password).not.toBe(PASSWORD);
    });

    it("never writes the password to the logs, whatever the outcome", async () => {
      const lines: string[] = [];
      const logged = Fastify({
        logger: { level: "trace", stream: { write: (line: string) => void lines.push(line) } },
      });
      logged.setErrorHandler((error, _request, reply) => {
        const e = error as Error & { statusCode?: number };
        return reply.status(e.statusCode ?? 500).send({ error: e.message });
      });
      await logged.register(authRoutes, { prefix: "/api/v1" });
      await logged.ready();

      const secret = "Zq9-never-log-this-pw";
      fake.addUser("jane", secret, ["dfwsc-admins"]);
      fake.addUser("intern", secret, ["staff"]);
      const attempt = (username: string, password: string) =>
        logged.inject({
          method: "POST",
          url: LOGIN,
          payload: { username, password },
          remoteAddress: nextIp(),
        });

      expect((await attempt("jane", secret)).statusCode).toBe(200);
      expect((await attempt("jane", `${secret}x`)).statusCode).toBe(401);
      expect((await attempt("intern", secret)).statusCode).toBe(403);
      fake.fail({ match: (r) => r.path.includes("/groups"), status: 500 });
      expect((await attempt("jane", secret)).statusCode).toBe(503);
      setEnv({ NEXTCLOUD_BASE_URL: undefined });
      expect((await attempt("jane", secret)).statusCode).toBe(503);
      await logged.close();

      expect(lines.length).toBeGreaterThan(0);
      const everything = lines.join("\n");
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(Buffer.from(`jane:${secret}`).toString("base64"));
    });
  });

  describe("admin routes accept the new token", () => {
    it("serves an admin route with no admins row anywhere", async () => {
      const token = (await login({ username: "jane", password: PASSWORD })).json().token;

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/groups?workspace=client_portal",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it("still refuses a token that is expired, tampered with, or not an admin's", async () => {
      const get = (token: string) =>
        app.inject({
          method: "GET",
          url: "/api/v1/groups?workspace=client_portal",
          headers: { authorization: `Bearer ${token}` },
        });
      const expired = jwt.sign({ role: "admin", sub: "jane" }, TEST_JWT_SECRET, { expiresIn: -5 });
      const viewer = jwt.sign({ role: "viewer", sub: "jane" }, TEST_JWT_SECRET, {
        expiresIn: "1h",
      });
      const wrongKey = jwt.sign({ role: "admin", sub: "jane" }, "x".repeat(40), {
        expiresIn: "1h",
      });

      expect((await get(expired)).statusCode).toBe(401);
      expect((await get(viewer)).statusCode).toBe(403);
      expect((await get(wrongKey)).statusCode).toBe(401);
    });
  });

  describe("removed local-admin routes", () => {
    it.each([
      ["GET", "/api/v1/auth/setup/status"],
      ["POST", "/api/v1/auth/setup"],
      ["POST", "/api/v1/auth/confirm-bootstrap"],
    ])("%s %s is gone (404)", async (method, url) => {
      const res = await app.inject({ method: method as "GET" | "POST", url });

      expect(res.statusCode).toBe(404);
    });
  });
});

describe("parseAdminGroups", () => {
  it("defaults to dfwsc-admins and managers when unset or blank", () => {
    expect(parseAdminGroups(undefined)).toEqual(["dfwsc-admins", "managers"]);
    expect(parseAdminGroups("")).toEqual(["dfwsc-admins", "managers"]);
    expect(parseAdminGroups(" , ,")).toEqual(["dfwsc-admins", "managers"]);
  });

  it("splits on commas and trims each entry", () => {
    expect(parseAdminGroups("a, b ,,c")).toEqual(["a", "b", "c"]);
  });
});
