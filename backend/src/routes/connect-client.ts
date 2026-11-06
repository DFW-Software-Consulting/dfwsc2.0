import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { z } from "zod";
import type { clients } from "../db/schema";
import { requireApiKey } from "../lib/auth";
import { withStripeCircuit } from "../lib/circuit-breakers";
import { allowedRedirectHref } from "../lib/connect-redirect";
import {
  CONNECT_CLIENT_LINK_RATE_LIMIT_MAX,
  CONNECT_CLIENT_STATUS_RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from "../lib/constants";
import { AppError, errors } from "../lib/errors";
import { rateLimit } from "../lib/rate-limit";
import { errorLogFields } from "../lib/safe-error-log";
import { stripe } from "../lib/stripe";
import {
  ensureExpressAccountForClient,
  syncClientFromAccount,
} from "../lib/stripe-connect-account";
import { mapStripeError } from "../lib/stripe-errors";
import { parseBody } from "../lib/validation";

// Client-facing Connect routes, called server-to-server by a client app with its x-api-key. The
// connected account is always the authenticated client's own stripeAccountId: no route reads an
// account or client id from the request. Logs carry the client id and Stripe account id only,
// never Stripe link URLs (they are bearer credentials) or the caller's redirect URLs.

type ClientRow = typeof clients.$inferSelect;
type RequestWithClient = FastifyRequest & { client: ClientRow };

const STRIPE_CIRCUIT_OPEN_ERROR = {
  error: "Stripe onboarding service is temporarily unavailable.",
  code: "STRIPE_CIRCUIT_OPEN",
};
const STRIPE_RATE_LIMITED_ERROR = {
  error: "Stripe is busy. Please retry.",
  code: "RATE_LIMITED",
};

const onboardingLinkBodySchema = z.object({
  returnUrl: z.string({ error: "returnUrl is required." }).trim().min(1).max(2048),
  refreshUrl: z.string({ error: "refreshUrl is required." }).trim().min(1).max(2048),
});

export default async function connectClientRoutes(fastify: FastifyInstance) {
  const clientKey = (request: FastifyRequest) =>
    `client:${(request as RequestWithClient).client.id}`;
  const linkGuards = [
    requireApiKey,
    rateLimit({
      max: CONNECT_CLIENT_LINK_RATE_LIMIT_MAX,
      windowMs: RATE_LIMIT_WINDOW_MS,
      name: "connect-client-link",
      keyGenerator: clientKey,
    }),
  ];
  const statusGuards = [
    requireApiKey,
    rateLimit({
      max: CONNECT_CLIENT_STATUS_RATE_LIMIT_MAX,
      windowMs: RATE_LIMIT_WINDOW_MS,
      name: "connect-client-status",
      keyGenerator: clientKey,
    }),
  ];

  // Replies for Stripe failures and returns true; false means the caller should rethrow.
  function replyStripeError(err: unknown, reply: FastifyReply): boolean {
    return mapStripeError(err, reply, {
      circuitOpen: STRIPE_CIRCUIT_OPEN_ERROR,
      rateLimited: STRIPE_RATE_LIMITED_ERROR,
      permanentErrors: true,
    });
  }

  // ── POST /connect/onboarding-link ─────────────────────────────────────────
  fastify.post("/connect/onboarding-link", { preHandler: linkGuards }, async (request, reply) => {
    const client = (request as RequestWithClient).client;
    const body = parseBody(onboardingLinkBodySchema, request.body, reply);
    if (!body) return;

    if (client.connectRedirectOrigins.length === 0) {
      return reply.code(409).send({
        error:
          "No redirect origins are configured for this client. Contact your DFWSC administrator.",
        code: "REDIRECT_ORIGINS_NOT_CONFIGURED",
      });
    }
    // Stripe gets the parsed href that passed the allowlist, never the raw string.
    const hrefs = {} as Record<"returnUrl" | "refreshUrl", string>;
    for (const field of ["returnUrl", "refreshUrl"] as const) {
      const href = allowedRedirectHref(body[field], client.connectRedirectOrigins);
      if (!href) {
        return reply.code(400).send({
          error: `${field} must be an https URL on one of this client's allowed origins.`,
          code: "REDIRECT_URL_NOT_ALLOWED",
        });
      }
      hrefs[field] = href;
    }

    try {
      // Creates the Express account on first use (idempotency key derived from the client id plus
      // a conditional write, so concurrent first calls end up with one persisted account).
      const stripeAccountId = await ensureExpressAccountForClient(client, request.log);
      const link = await withStripeCircuit(() =>
        stripe.accountLinks.create({
          account: stripeAccountId,
          return_url: hrefs.returnUrl,
          refresh_url: hrefs.refreshUrl,
          type: "account_onboarding",
        })
      );
      request.log.info(
        { clientId: client.id, stripeAccountId, firstAccount: !client.stripeAccountId },
        "Client Connect onboarding link created"
      );
      return reply.send({
        url: link.url,
        expiresAt: new Date(link.expires_at * 1000).toISOString(),
      });
    } catch (err) {
      request.log.error(
        { ...errorLogFields(err), clientId: client.id },
        "Client Connect onboarding link failed"
      );
      if (err instanceof AppError) throw err;
      if (replyStripeError(err, reply)) return;
      throw errors.stripeFailed("Failed to create the onboarding link. Please try again.");
    }
  });

  // Live account read; a failure is sent (or thrown) and null returned.
  async function retrieveAndSync(
    request: FastifyRequest,
    reply: FastifyReply,
    client: ClientRow,
    stripeAccountId: string
  ): Promise<Stripe.Account | null> {
    try {
      const account = await withStripeCircuit(() => stripe.accounts.retrieve(stripeAccountId));
      await syncClientFromAccount(client.id, account);
      return account;
    } catch (err) {
      request.log.error(
        { ...errorLogFields(err), clientId: client.id },
        "Client Connect account read failed"
      );
      if (replyStripeError(err, reply)) return null;
      throw errors.stripeFailed("Failed to read the Stripe account. Please try again.");
    }
  }

  // ── GET /connect/account ──────────────────────────────────────────────────
  fastify.get("/connect/account", { preHandler: statusGuards }, async (request, reply) => {
    const client = (request as RequestWithClient).client;
    if (!client.stripeAccountId) {
      return reply.send({
        hasAccount: false,
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: { currentlyDue: [], pastDue: [], disabledReason: null },
        capabilities: {},
      });
    }
    const account = await retrieveAndSync(request, reply, client, client.stripeAccountId);
    if (!account) return;
    return reply.send({
      hasAccount: true,
      detailsSubmitted: account.details_submitted ?? false,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      requirements: {
        currentlyDue: account.requirements?.currently_due ?? [],
        pastDue: account.requirements?.past_due ?? [],
        disabledReason: account.requirements?.disabled_reason ?? null,
      },
      capabilities: { ...(account.capabilities ?? {}) },
    });
  });

  // ── POST /connect/dashboard-link ──────────────────────────────────────────
  // Express accounts update bank and payout details in the Express Dashboard, reached with a login
  // link. (account_update Account Links are not available for accounts with a Stripe-hosted
  // dashboard.) Stripe only issues a login link once onboarding is complete.
  fastify.post("/connect/dashboard-link", { preHandler: linkGuards }, async (request, reply) => {
    const client = (request as RequestWithClient).client;
    const notOnboarded = {
      error: "Stripe onboarding is not complete. Use the onboarding link first.",
      code: "ONBOARDING_INCOMPLETE",
    };
    if (!client.stripeAccountId) return reply.code(409).send(notOnboarded);

    const account = await retrieveAndSync(request, reply, client, client.stripeAccountId);
    if (!account) return;
    if (!account.details_submitted) return reply.code(409).send(notOnboarded);

    try {
      const link = await withStripeCircuit(() =>
        stripe.accounts.createLoginLink(client.stripeAccountId as string)
      );
      request.log.info(
        { clientId: client.id, stripeAccountId: client.stripeAccountId },
        "Client Connect dashboard link created"
      );
      return reply.send({ url: link.url });
    } catch (err) {
      request.log.error(
        { ...errorLogFields(err), clientId: client.id },
        "Client Connect dashboard link failed"
      );
      if (replyStripeError(err, reply)) return;
      throw errors.stripeFailed("Failed to create the dashboard link. Please try again.");
    }
  });
}
