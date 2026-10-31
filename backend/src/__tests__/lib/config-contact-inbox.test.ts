import { afterEach, describe, expect, it } from "vitest";
import { resolveContactInboxEmail } from "../../lib/config";

const originalContactInbox = process.env.CONTACT_INBOX;
const originalSmtpFrom = process.env.SMTP_FROM;

describe("resolveContactInboxEmail", () => {
  afterEach(() => {
    if (originalContactInbox === undefined) delete process.env.CONTACT_INBOX;
    else process.env.CONTACT_INBOX = originalContactInbox;

    if (originalSmtpFrom === undefined) delete process.env.SMTP_FROM;
    else process.env.SMTP_FROM = originalSmtpFrom;
  });

  it("falls back to SMTP_FROM when CONTACT_INBOX is blank", () => {
    process.env.CONTACT_INBOX = "   ";
    process.env.SMTP_FROM = " fallback@example.com ";

    expect(resolveContactInboxEmail()).toBe("fallback@example.com");
  });

  it("uses a configured CONTACT_INBOX", () => {
    process.env.CONTACT_INBOX = " inbox@example.com ";
    process.env.SMTP_FROM = "fallback@example.com";

    expect(resolveContactInboxEmail()).toBe("inbox@example.com");
  });

  it("rejects a nonblank invalid CONTACT_INBOX instead of falling back", () => {
    process.env.CONTACT_INBOX = "not-an-email";
    process.env.SMTP_FROM = "fallback@example.com";

    expect(() => resolveContactInboxEmail()).toThrow(
      "CONTACT_INBOX must be a valid email address."
    );
  });

  it("rejects an invalid SMTP_FROM fallback", () => {
    process.env.CONTACT_INBOX = "   ";
    process.env.SMTP_FROM = "not-an-email";

    expect(() => resolveContactInboxEmail()).toThrow("SMTP_FROM must be a valid email address.");
  });
});
