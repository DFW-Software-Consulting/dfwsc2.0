import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveContactInboxEmail } from "../lib/config";
import { RATE_LIMIT_WINDOW_MS, STRICT_RATE_LIMIT_MAX } from "../lib/constants";
import { errors } from "../lib/errors";
import { sendMail } from "../lib/mailer";
import { rateLimit } from "../lib/rate-limit";
import { transportErrorFields } from "../lib/safe-error-log";
import { parseBody } from "../lib/validation";
import {
  isWebsiteLeadEnabled,
  reserveWebsiteLeadSlot,
  submitWebsiteLead,
} from "../lib/website-lead";

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
  company: z
    .string({ error: "company is required." })
    .trim()
    .min(1, "company is required.")
    .max(100, "company must not exceed 100 characters."),
});

export default async function contactRoutes(fastify: FastifyInstance) {
  // ── POST /contact ──────────────────────────────────────────────────────────
  // Public lead-capture endpoint (no auth). Rate-limited with the same tier
  // used by other public/token-based routes (STRICT_RATE_LIMIT_MAX per IP).
  // `_hp` is a honeypot field: real users never see or fill it (hidden via
  // CSS on the frontend), so a non-empty value is treated as a bot and
  // silently dropped — no email is sent, and the response (201 {ok:true}) is
  // identical to a real success, to avoid tipping off the bot.
  fastify.post(
    "/contact",
    {
      preHandler: [rateLimit({ max: STRICT_RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS })],
    },
    async (request, reply) => {
      const rawBody = (request.body ?? {}) as Record<string, unknown>;
      const honeypot = typeof rawBody._hp === "string" ? rawBody._hp : undefined;
      if (honeypot && honeypot.length > 0) {
        return reply.code(201).send({ ok: true });
      }

      const body = parseBody(contactBodySchema, request.body, reply);
      if (!body) return;
      const { name, email, message, company } = body;

      const submittedAt = new Date().toISOString();

      const mailText = [
        `New contact form submission from ${name}`,
        "",
        `Name: ${name}`,
        `Email: ${email}`,
        `Company: ${company}`,
        `Submitted: ${submittedAt}`,
        "",
        "Message:",
        message,
      ].join("\n");

      // Email and lead run in parallel; either one succeeding is enough, so a
      // Nextcloud outage never loses a message that reached the inbox and vice versa.
      const channels: { name: "email" | "lead"; run: Promise<unknown> }[] = [
        {
          name: "email",
          // Resolved inside the channel: a missing or invalid inbox fails email only.
          run: (async () =>
            sendMail({
              to: resolveContactInboxEmail(),
              subject: `New contact form submission from ${name}`,
              text: mailText,
            }))(),
        },
      ];
      if (isWebsiteLeadEnabled()) {
        if (reserveWebsiteLeadSlot()) {
          channels.push({
            name: "lead",
            run: submitWebsiteLead({ company, name, email, message }),
          });
        } else {
          request.log.warn({ event: "contact.lead_cap_reached" }, "contact.lead_cap_reached");
        }
      }
      const results = await Promise.allSettled(channels.map((c) => c.run));
      let delivered = false;
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          delivered = true;
          return;
        }
        // Never log the message body or the submitter's details.
        request.log.error(
          { ...transportErrorFields(result.reason), channel: channels[i].name },
          "Contact form channel failed"
        );
      });
      if (!delivered) {
        throw errors.emailFailed("Failed to send your message. Please email us directly instead.");
      }

      return reply.code(201).send({ ok: true });
    }
  );
}
