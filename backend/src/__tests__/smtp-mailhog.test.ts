import nodemailer from "nodemailer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTransporterCache, createTransport, sendMail } from "../lib/mailer";

vi.mock("nodemailer");

const mockSendMail = vi.fn().mockResolvedValue({ messageId: "test-id" });
const mockCreateTransport = vi.mocked(nodemailer.createTransport);

beforeEach(() => {
  vi.resetAllMocks();
  mockCreateTransport.mockReturnValue({ sendMail: mockSendMail } as ReturnType<
    typeof nodemailer.createTransport
  >);

  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "user@example.com";
  process.env.SMTP_PASS = "secret";
  process.env.SMTP_FROM = "no-reply@example.com";

  clearTransporterCache();
});

describe("mailer", () => {
  describe("createTransport", () => {
    it("creates a transporter with the configured SMTP settings", () => {
      createTransport();

      expect(mockCreateTransport).toHaveBeenCalledWith({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "user@example.com", pass: "secret" },
      });
    });

    it("sets secure: true for port 465", () => {
      process.env.SMTP_PORT = "465";
      createTransport();

      expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
    });

    it("throws if SMTP config is incomplete", () => {
      delete process.env.SMTP_HOST;
      expect(() => createTransport()).toThrow("SMTP configuration is incomplete.");
    });

    it("throws if SMTP_PORT is not a positive integer", () => {
      process.env.SMTP_PORT = "abc";
      expect(() => createTransport()).toThrow("SMTP_PORT must be a positive integer.");
    });
  });

  describe("sendMail", () => {
    it("sends an email with the correct fields", async () => {
      await sendMail({ to: "client@example.com", subject: "Hello", text: "Body text" });

      expect(mockSendMail).toHaveBeenCalledWith({
        from: "no-reply@example.com",
        to: "client@example.com",
        subject: "Hello",
        text: "Body text",
        html: undefined,
      });
    });

    it("falls back to SMTP_USER@SMTP_HOST when SMTP_FROM is not set", async () => {
      delete process.env.SMTP_FROM;

      await sendMail({ to: "client@example.com", subject: "Hi", text: "Hi" });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: "user@example.com@smtp.example.com" })
      );
    });

    it("reuses the cached transporter on subsequent calls", async () => {
      await sendMail({ to: "a@b.com", subject: "First", text: "First" });
      await sendMail({ to: "a@b.com", subject: "Second", text: "Second" });

      expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    });
  });
});
