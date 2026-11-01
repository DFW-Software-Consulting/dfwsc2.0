import { vi } from "vitest";

vi.mock("../../lib/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  clearTransporterCache: vi.fn(),
}));

vi.mock("../../lib/website-lead", () => ({
  isWebsiteLeadEnabled: vi.fn().mockReturnValue(true),
  reserveWebsiteLeadSlot: vi.fn().mockReturnValue(true),
  submitWebsiteLead: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/auth")>();
  return { ...original, signJwt: vi.fn(original.signJwt) };
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { signJwt } from "../../lib/auth";
import { sendMail } from "../../lib/mailer";
import { hitBuckets } from "../../lib/rate-limit";
import { submitWebsiteLead } from "../../lib/website-lead";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";
import { FakeLoginNextcloud, loginEnv } from "../helpers/fake-nextcloud-login";
import {
  captureAppLogs,
  dump,
  expectNoPlanted,
  PLANTED_EMAIL,
  plantedDbError,
  plantedMailError,
} from "../helpers/log-capture";

// Every error-log call site swept for raw error objects: the logger must receive identifiers
// only, never the quoted email, URL or SQL parameter planted in the thrown error.
describe("error logging keeps secrets, PII and database values out", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let logs: ReturnType<typeof captureAppLogs>;

  beforeEach(async () => {
    ensureBaseEnv();
    process.env.CONTACT_INBOX = "inbox@example.com";
    hitBuckets.clear();
    vi.clearAllMocks();
    app = await buildServer();
    logs = captureAppLogs(app);
  });

  afterEach(async () => {
    logs.restore();
    vi.restoreAllMocks();
    hitBuckets.clear();
    await app.close();
  });

  const admin = () => ({ authorization: `Bearer ${makeAdminToken()}` });

  it("health: logs SQLSTATE and schema names for a database failure", async () => {
    vi.spyOn(db, "execute").mockRejectedValueOnce(plantedDbError() as never);
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(503);
    expect(logs.find("Health check failed - database connection error")?.fields).toMatchObject({
      errCode: "23505",
      errConstraint: "uq_planted",
    });
    expectNoPlanted(logs.text());
  });

  it("settings: update failure logs no row values", async () => {
    vi.spyOn(db, "insert").mockImplementationOnce((() => {
      throw plantedDbError();
    }) as never);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/company_name",
      headers: admin(),
      payload: { value: "Acme" },
    });
    expect(res.statusCode).toBe(500);
    expect(logs.find("Error updating setting")?.fields).toMatchObject({ errCode: "23505" });
    expectNoPlanted(logs.text());
  });

  it("clients: list, update and delete failures log no row values", async () => {
    const boom = () => {
      throw plantedDbError();
    };
    vi.spyOn(db, "select").mockImplementation(boom as never);
    vi.spyOn(db, "update").mockImplementation(boom as never);
    const id = randomUUID();

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/clients?workspace=client_portal",
      headers: admin(),
    });
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/clients/${id}`,
      headers: admin(),
      payload: { name: "New name" },
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/clients/${id}`,
      headers: admin(),
    });

    expect([list.statusCode, patch.statusCode, del.statusCode]).toEqual([500, 500, 500]);
    for (const msg of [
      "Error fetching client list",
      "Error updating client",
      "Error deleting client",
    ]) {
      expect(logs.find(msg)?.fields).toMatchObject({ errCode: "23505", errTable: "planted_table" });
    }
    expectNoPlanted(logs.text());
  });

  it("config: a missing API_BASE_URL keeps its message and stack (our own bug)", async () => {
    const saved = process.env.API_BASE_URL;
    delete process.env.API_BASE_URL;
    try {
      const res = await app.inject({ method: "GET", url: "/app-config.js" });
      expect(res.statusCode).toBe(500);
      expect(logs.find("Failed to resolve API base URL")?.fields).toMatchObject({
        errMessage: expect.stringContaining("API_BASE_URL"),
        errStack: expect.any(String),
      });
    } finally {
      if (saved !== undefined) process.env.API_BASE_URL = saved;
    }
  });

  it("error handler: an unhandled 5xx logs identifiers and a fixed line, not the message", async () => {
    app.get("/__boom", async () => {
      throw plantedDbError();
    });
    const res = await app.inject({ method: "GET", url: "/__boom" });
    expect(res.statusCode).toBe(500);
    const entry = logs.calls.find((c) => (c.fields as any)?.errCode === "23505");
    expect(entry?.msg).toBe("Request failed with a server error");
    expectNoPlanted(logs.text());
  });

  it("auth: a JWT signing failure logs the error name and message but no token", async () => {
    const fake = new FakeLoginNextcloud();
    fake.addUser("jane", "pw-planted", ["admins"]);
    const saved = { ...process.env };
    Object.assign(process.env, loginEnv(), { ADMIN_NEXTCLOUD_GROUPS: "admins" });
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
    vi.mocked(signJwt).mockImplementationOnce(() => {
      throw new Error("secretOrPrivateKey must have a value");
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "jane", password: "pw-planted" },
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const entry = logs.find("Error generating JWT token");
      expect(entry?.fields).toMatchObject({ errMessage: "secretOrPrivateKey must have a value" });
      expect(dump(logs.calls.filter((c) => c.level === "error"))).not.toContain("pw-planted");
    } finally {
      vi.unstubAllGlobals();
      Object.assign(process.env, saved);
    }
  });

  it("contact: SMTP and lead failures log name, code, response code and command only", async () => {
    vi.mocked(sendMail).mockRejectedValueOnce(plantedMailError());
    vi.mocked(submitWebsiteLead).mockRejectedValueOnce(
      Object.assign(new Error(`Nextcloud answered 500 body ${PLANTED_EMAIL}`), {
        name: "NextcloudHttpError",
        status: 500,
      })
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: { name: "Jane", email: PLANTED_EMAIL, message: "hello there", company: "Acme" },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const failures = logs.calls.filter((c) => c.msg === "Contact form channel failed");
    expect(failures.map((c) => (c.fields as any).channel).sort()).toEqual(["email", "lead"]);
    expect(failures.find((c) => (c.fields as any).channel === "email")?.fields).toMatchObject({
      errCode: "EENVELOPE",
      errResponseCode: 550,
      errCommand: "RCPT TO",
    });
    expect(failures.find((c) => (c.fields as any).channel === "lead")?.fields).toMatchObject({
      errName: "NextcloudHttpError",
      errStatus: 500,
    });
    expectNoPlanted(dump(failures));
  });
});
