vi.mock("../../lib/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  clearTransporterCache: vi.fn(),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { sendMail } from "../../lib/mailer";
import { hitBuckets } from "../../lib/rate-limit";
import { ensureBaseEnv } from "../helpers/env";

describe("POST /api/v1/contact", () => {
  let app: any;

  const validPayload = () => ({
    name: "Jane Doe",
    email: "jane@example.com",
    message: "Hello, I would like a quote.",
    company: "Acme Co",
  });

  beforeEach(async () => {
    ensureBaseEnv();
    process.env.CONTACT_INBOX = "inbox@example.com";
    hitBuckets.clear();
    vi.clearAllMocks();
    (sendMail as any).mockResolvedValue(undefined);
    app = await buildServer();
  });

  afterEach(async () => {
    hitBuckets.clear();
    if (app) await app.close();
  });

  it("returns 201 and sends exactly one email for a valid submission", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: validPayload(),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true });
    expect(sendMail).toHaveBeenCalledTimes(1);

    const call = (sendMail as any).mock.calls[0][0];
    expect(call.to).toBe("inbox@example.com");
    expect(call.subject).toBe("New contact form submission from Jane Doe");
    expect(call.text).toContain("jane@example.com");
    expect(call.text).toContain("Acme Co");
    expect(call.text).toContain("Hello, I would like a quote.");
  });

  it("returns 201 without a company field (optional)", async () => {
    const { company: _company, ...payload } = validPayload();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload,
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(201);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = (sendMail as any).mock.calls[0][0];
    expect(call.text).toContain("Company: (none)");
  });

  it("returns 200 and does not send email when the honeypot field is filled", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: { ...validPayload(), _hp: "i-am-a-bot" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("returns 200 and drops the submission even when other fields are invalid, as long as the honeypot is filled", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: { _hp: "bot-signature" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("ignores an empty honeypot field and still processes normally", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: { ...validPayload(), _hp: "" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(201);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing name", { ...validPayload(), name: undefined }],
    ["empty name", { ...validPayload(), name: "" }],
    ["name over 100 chars", { ...validPayload(), name: "a".repeat(101) }],
    ["missing email", { ...validPayload(), email: undefined }],
    ["invalid email", { ...validPayload(), email: "not-an-email" }],
    ["missing message", { ...validPayload(), message: undefined }],
    ["empty message", { ...validPayload(), message: "" }],
    ["message over 2000 chars", { ...validPayload(), message: "a".repeat(2001) }],
    ["company over 100 chars", { ...validPayload(), company: "a".repeat(101) }],
  ])("returns 400 for %s", async (_label, payload) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload,
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("returns 502 EMAIL_DELIVERY_FAILED when the mailer rejects", async () => {
    (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: validPayload(),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("rate limits after the configured max requests per window (10/min)", async () => {
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/contact",
        payload: validPayload(),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(201);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: validPayload(),
      headers: { "content-type": "application/json" },
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
    expect(sendMail).toHaveBeenCalledTimes(10);
  });
});
