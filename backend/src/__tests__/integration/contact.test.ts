vi.mock("../../lib/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  clearTransporterCache: vi.fn(),
}));

vi.mock("../../lib/website-lead", () => ({
  isWebsiteLeadEnabled: vi.fn().mockReturnValue(false),
  reserveWebsiteLeadSlot: vi.fn().mockReturnValue(true),
  submitWebsiteLead: vi.fn().mockResolvedValue(undefined),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { sendMail } from "../../lib/mailer";
import { hitBuckets } from "../../lib/rate-limit";
import {
  isWebsiteLeadEnabled,
  reserveWebsiteLeadSlot,
  submitWebsiteLead,
} from "../../lib/website-lead";
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
    (isWebsiteLeadEnabled as any).mockReturnValue(false);
    (reserveWebsiteLeadSlot as any).mockReturnValue(true);
    (submitWebsiteLead as any).mockResolvedValue(undefined);
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

  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload,
      headers: { "content-type": "application/json" },
    });

  it("includes a valid visit context in the email and the lead", async () => {
    (isWebsiteLeadEnabled as any).mockReturnValue(true);
    const context = {
      referrer: "google.com",
      landingPath: "/services",
      utm: { source: "linkedin", medium: "social" },
      pages: ["/services", "/pricing"],
      secondsOnSite: 192,
    };
    const response = await post({ ...validPayload(), context });

    expect(response.statusCode).toBe(201);
    const text = (sendMail as any).mock.calls[0][0].text as string;
    expect(text).toContain("Hello, I would like a quote.\n\n--- Visit context ---");
    expect(text).toContain("Found us via: google.com");
    expect(text).toContain("Campaign: linkedin / social");
    expect(text).toContain("Pages viewed (2): /services → /pricing");
    expect(text).toContain("Time on site: 3m 12s");
    expect((submitWebsiteLead as any).mock.calls[0][0].context).toEqual(context);
  });

  it("adds no context block when none is sent", async () => {
    const response = await post(validPayload());
    expect(response.statusCode).toBe(201);
    expect((sendMail as any).mock.calls[0][0].text).not.toContain("Visit context");
  });

  it.each([
    ["a string", "google.com"],
    ["an array", []],
    ["a referrer with a slash", { referrer: "google.com/search" }],
    ["21 pages", { pages: Array.from({ length: 21 }, () => "/a") }],
    ["a bad page path", { pages: ["no-slash"] }],
    ["newline injection in utm", { utm: { source: "x\nBcc: evil@example.com" } }],
    ["a float for seconds", { secondsOnSite: 1.5 }],
    ["an unknown key", { referrer: "google.com", extra: "x" }],
  ])("still returns 201 and drops the context for %s", async (_label, context) => {
    (isWebsiteLeadEnabled as any).mockReturnValue(true);
    const response = await post({ ...validPayload(), context });

    expect(response.statusCode).toBe(201);
    expect((sendMail as any).mock.calls[0][0].text).not.toContain("Visit context");
    expect((submitWebsiteLead as any).mock.calls[0][0].context).toBeUndefined();
  });

  it("returns 201 and does not send email when the honeypot field is filled", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: { ...validPayload(), _hp: "i-am-a-bot" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("returns 201 and drops the submission even when other fields are invalid, as long as the honeypot is filled", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/contact",
      payload: { _hp: "bot-signature" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(201);
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
    ["missing company", { ...validPayload(), company: undefined }],
    ["blank company", { ...validPayload(), company: "   " }],
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

  describe("lead channel", () => {
    const post = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/contact",
        payload: validPayload(),
        headers: { "content-type": "application/json" },
      });

    beforeEach(() => {
      (isWebsiteLeadEnabled as any).mockReturnValue(true);
    });

    it("does not touch the lead channel when automation is off", async () => {
      (isWebsiteLeadEnabled as any).mockReturnValue(false);
      const response = await post();
      expect(response.statusCode).toBe(201);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(submitWebsiteLead).not.toHaveBeenCalled();
    });

    it("sends the email and the lead when both work", async () => {
      const response = await post();
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ ok: true });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(submitWebsiteLead).toHaveBeenCalledWith({
        company: "Acme Co",
        name: "Jane Doe",
        email: "jane@example.com",
        message: "Hello, I would like a quote.",
      });
    });

    it("returns 201 when the email fails but the lead is created", async () => {
      (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));
      const response = await post();
      expect(response.statusCode).toBe(201);
      expect(submitWebsiteLead).toHaveBeenCalledTimes(1);
    });

    it("returns 201 when the lead fails but the email is sent", async () => {
      (submitWebsiteLead as any).mockRejectedValueOnce(new Error("nextcloud down"));
      const response = await post();
      expect(response.statusCode).toBe(201);
      expect(sendMail).toHaveBeenCalledTimes(1);
    });

    it("returns 502 EMAIL_DELIVERY_FAILED when both channels fail", async () => {
      (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));
      (submitWebsiteLead as any).mockRejectedValueOnce(new Error("nextcloud down"));
      const response = await post();
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
    });

    it("keeps the lead channel alive when no inbox is configured", async () => {
      delete process.env.CONTACT_INBOX;
      delete process.env.SMTP_FROM;
      const response = await post();
      expect(response.statusCode).toBe(201);
      expect(sendMail).not.toHaveBeenCalled();
      expect(submitWebsiteLead).toHaveBeenCalledTimes(1);
    });

    it("returns 502 when no inbox is configured and the lead channel is off", async () => {
      delete process.env.CONTACT_INBOX;
      delete process.env.SMTP_FROM;
      (isWebsiteLeadEnabled as any).mockReturnValue(false);
      const response = await post();
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
    });

    it("skips the lead but still emails when the global lead cap is reached", async () => {
      (reserveWebsiteLeadSlot as any).mockReturnValue(false);
      const response = await post();
      expect(response.statusCode).toBe(201);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(submitWebsiteLead).not.toHaveBeenCalled();
    });

    it("returns 502 when the lead cap is reached and the email fails", async () => {
      (reserveWebsiteLeadSlot as any).mockReturnValue(false);
      (sendMail as any).mockRejectedValueOnce(new Error("smtp down"));
      const response = await post();
      expect(response.statusCode).toBe(502);
    });

    it("runs neither channel for a honeypot hit", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/contact",
        payload: { ...validPayload(), _hp: "bot" },
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(201);
      expect(sendMail).not.toHaveBeenCalled();
      expect(submitWebsiteLead).not.toHaveBeenCalled();
    });

    it("runs neither channel when company is missing", async () => {
      const { company: _c, ...payload } = validPayload();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/contact",
        payload,
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      expect(sendMail).not.toHaveBeenCalled();
      expect(submitWebsiteLead).not.toHaveBeenCalled();
    });
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
