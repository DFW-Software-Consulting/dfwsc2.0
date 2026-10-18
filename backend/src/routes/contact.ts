import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveContactInboxEmail } from "../lib/config";
import { RATE_LIMIT_WINDOW_MS, STRICT_RATE_LIMIT_MAX } from "../lib/constants";
import { errors } from "../lib/errors";
import { sendMail } from "../lib/mailer";
import { rateLimit } from "../lib/rate-limit";
import { parseBody } from "../lib/validation";

const contactBodySchema = z.object({
  name: z
    .string({ error: "name is required." })
    .trim()
    .min(1, "name is required.")
    .max(100, "name must not exceed 100 characters."),
  email: z
    .string({ error: "email is required." })
    .trim()
    .max(320, "email must not exceed 320 characters.")
    .email("email must be a valid email address."),
  message: z
    .string({ error: "message is required." })
    .trim()
    .min(1, "message is required.")
    .max(2000, "message must not exceed 2000 characters."),
  company: z.string().trim().max(100, "company must not exceed 100 characters.").optional(),
});

export default async function contactRoutes(fastify: FastifyInstance) {
  // ── POST /contact ──────────────────────────────────────────────────────────
  // Public lead-capture endpoint (no auth). Rate-limited with the same tier
  // used by other public/token-based routes (STRICT_RATE_LIMIT_MAX per IP).
  // `_hp` is a honeypot field: real users never see or fill it (hidden via
  // CSS on the frontend), so a non-empty value is treated as a bot and
  // silently dropped — no email is sent, and the response is indistinguishable
  // from a real success, to avoid tipping off the bot.
  fastify.post(
    "/contact",
    {
      preHandler: [rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS })],
    },
    async (request, reply) => {
      const rawBody = (request.body ?? {}) as Record<string, unknown>;
      const honeypot = typeof rawBody._hp === "string" ? rawBody._hp : undefined;
      if (honeypot && honeypot.length > 0) {
        return reply.code(200).send({ ok: true });
      }

      const body = parseBody(contactBodySchema, request.body, reply);
      if (!body) return;
      const { name, email, message, company } = body;

      const inbox = resolveContactInboxEmail();
      const submittedAt = new Date().toISOString();

      const mailText = [
        `New contact form submission from ${name}`,
        "",
        `Name: ${name}`,
        `Email: ${email}`,
        `Company: ${company ?? "(none)"}`,
        `Submitted: ${submittedAt}`,
        "",
        "Message:",
        message,
      ].join("\n");

      try {
        await sendMail({
          to: inbox,
          subject: `New contact form submission from ${name}`,
          text: mailText,
        });
      } catch (err) {
        request.log.error({ err }, "Failed to send contact form email");
        throw errors.emailFailed("Failed to send your message. Please email us directly instead.");
      }

      return reply.code(201).send({ ok: true });
    }
  );
}
