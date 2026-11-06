import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getBillingRequestsWebhook } from "../lib/billing-request-sync";
import { getClientOnboardingWebhook } from "../lib/client-onboarding-sync";
import {
  BILLING_REQUESTS_WEBHOOK_RATE_LIMIT_MAX,
  CLIENT_ONBOARDING_WEBHOOK_RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from "../lib/constants";
import { rateLimit } from "../lib/rate-limit";

/**
 * Compares `Authorization: Bearer <secret>` with the configured secret in constant
 * time. Both sides are hashed first so neither the comparison nor an early length
 * check reveals the secret's length.
 */
export function isAuthorizedWebhook(authHeader: string | undefined, secret: string): boolean {
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b) && provided.length > 0;
}

// Nextcloud's webhook_listeners sends the JSON body without a Content-Type header,
// which Fastify would refuse with 415 before the route runs. The body is never used,
// so in this plugin's scope only, any (or no) content type is accepted and the body
// is drained and dropped.
const WEBHOOK_BODY_LIMIT = 256 * 1024;

export default async function nextcloudWebhookRoutes(fastify: FastifyInstance) {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    "*",
    { bodyLimit: WEBHOOK_BODY_LIMIT },
    (_request, payload, done) => {
      payload.on("error", done);
      payload.on("end", () => done(null, undefined));
      payload.resume();
    }
  );

  // ── POST /webhooks/nextcloud/client-onboarding ──────────────────────────────
  // Called by Nextcloud's webhook_listeners app on OCA\Forms\Events\FormSubmittedEvent.
  // The body is never read: it only means "the form may have a new submission", so
  // a cycle is started (or queued behind the running one) and the submissions are
  // re-read from the Forms API. Answers 202 at once; the work runs in the background.
  // 404 when the onboarding or its webhook secret is not configured.
  // The rate limit and the secret check run in onRequest, before Fastify buffers the
  // body (up to 256 KB), so a refused request never costs a body read.
  fastify.post(
    "/webhooks/nextcloud/client-onboarding",
    {
      onRequest: [
        rateLimit({
          max: CLIENT_ONBOARDING_WEBHOOK_RATE_LIMIT_MAX,
          windowMs: RATE_LIMIT_WINDOW_MS,
        }),
        async (request, reply) => {
          const webhook = getClientOnboardingWebhook();
          if (!webhook) return reply.status(404).send({ error: "Not Found" });
          if (!isAuthorizedWebhook(request.headers.authorization, webhook.secret)) {
            request.log.warn("Nextcloud webhook rejected: bad or missing secret.");
            return reply.status(401).send({ error: "Unauthorized" });
          }
        },
      ],
    },
    async (_request, reply) => {
      // The secret was checked in onRequest; the webhook can only have gone away since.
      const webhook = getClientOnboardingWebhook();
      if (!webhook) return reply.status(404).send({ error: "Not Found" });
      webhook.trigger();
      return reply.status(202).send({ accepted: true });
    }
  );

  // ── POST /webhooks/nextcloud/billing-request ────────────────────────────────
  // Same contract as the client-onboarding webhook, for the "New invoice" form: called by
  // webhook_listeners on OCA\Forms\Events\FormSubmittedEvent, the body is never read, it only
  // starts (or queues) a cycle that re-reads the submissions from the Forms API. 404 when billing
  // requests or their webhook secret are not configured; 401 on a wrong secret.
  fastify.post(
    "/webhooks/nextcloud/billing-request",
    {
      onRequest: [
        rateLimit({
          max: BILLING_REQUESTS_WEBHOOK_RATE_LIMIT_MAX,
          windowMs: RATE_LIMIT_WINDOW_MS,
        }),
        async (request, reply) => {
          const webhook = getBillingRequestsWebhook();
          if (!webhook) return reply.status(404).send({ error: "Not Found" });
          if (!isAuthorizedWebhook(request.headers.authorization, webhook.secret)) {
            request.log.warn("Nextcloud billing request webhook rejected: bad or missing secret.");
            return reply.status(401).send({ error: "Unauthorized" });
          }
        },
      ],
    },
    async (_request, reply) => {
      const webhook = getBillingRequestsWebhook();
      if (!webhook) return reply.status(404).send({ error: "Not Found" });
      webhook.trigger();
      return reply.status(202).send({ accepted: true });
    }
  );
}
