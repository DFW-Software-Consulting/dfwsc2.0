import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db } from "../db/client";
import { clientGroups, clients, paymentLedger } from "../db/schema";
import {
  isRecentlyVerifiedApiKey,
  requireAdminJwt,
  requireApiKey,
  sha256Lookup,
} from "../lib/auth";
import { getCircuitBreakerStates, withStripeCircuit } from "../lib/circuit-breakers";
import { getClientIp } from "../lib/client-ip";
import {
  appendCheckoutSessionId,
  resolveDefaultPaymentCancelUrl,
  resolveDefaultPaymentSuccessUrl,
  resolveFrontendOrigin,
} from "../lib/config";
import {
  PAYMENT_CREATE_BUCKET_CAPACITY,
  PAYMENT_CREATE_REFILL_PER_MINUTE,
  REPORT_MAX_CONCURRENCY,
  SESSION_STATUS_ANONYMOUS_RATE_LIMIT_MAX,
  SESSION_STATUS_API_KEY_RATE_LIMIT_MAX,
  SESSION_STATUS_FAILED_AUTH_RATE_LIMIT_MAX,
} from "../lib/constants";
import { errors } from "../lib/errors";
import {
  adminRateLimit,
  type FailureCharge,
  failureRateLimit,
  rateLimit,
  sendRateLimited,
  tokenBucketRateLimit,
} from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { resolveClientFee } from "../lib/stripe-billing";
import { mapStripeError } from "../lib/stripe-errors";
import { parseBody, validateWorkspace, validateWorkspaceQuery } from "../lib/validation";
import { applyCheckoutSessionOutcome } from "./webhooks";

// ── Sanitize Stripe PaymentIntent for reports ──────────────────────────────────
// Returns only the fields needed by the frontend/admin reports.
// Never return raw Stripe objects — they contain sensitive data like full
// card details, internal IDs, and API metadata.
function sanitizePaymentIntent(
  pi: Stripe.PaymentIntent,
  extra?: { clientId?: string; clientName?: string }
): Record<string, unknown> {
  return {
    id: pi.id,
    amount: pi.amount,
    amountReceived: pi.amount_received,
    currency: pi.currency,
    status: pi.status,
    created: pi.created,
    description: pi.description ?? null,
    metadata: pi.metadata ?? {},
    paymentMethod: pi.payment_method ?? null,
    ...(extra?.clientId ? { clientId: extra.clientId } : {}),
    ...(extra?.clientName ? { clientName: extra.clientName } : {}),
  };
}

// ── Stale checkout reconciliation ──────────────────────────────────────────────
// Ledger status is normally written by webhooks. If the row is still "created"
// after RECONCILE_MIN_AGE_MS the completion event may have been lost, so the
// status endpoint asks Stripe and applies the transition the webhook would.
const RECONCILE_MIN_AGE_MS = 30_000;
// At most one Stripe lookup per session per interval, so a polling client
// cannot turn this public endpoint into a Stripe call per request. In-memory
// and per process: with several API instances the worst case is one lookup per
// instance per interval.
const RECONCILE_INTERVAL_MS = 30_000;
const RECONCILE_MAX_TRACKED = 1000;
// This endpoint is public and polled, so the fallback lookup gets a much
// shorter per-request budget than the shared Stripe client (10s, 1 retry).
const RECONCILE_STRIPE_TIMEOUT_MS = 3000;
const lastReconcileAttempt = new Map<string, number>();

function shouldAttemptReconcile(sessionId: string, now: number): boolean {
  const last = lastReconcileAttempt.get(sessionId);
  if (last !== undefined && now - last < RECONCILE_INTERVAL_MS) return false;
  if (lastReconcileAttempt.size >= RECONCILE_MAX_TRACKED) {
    for (const [id, at] of lastReconcileAttempt) {
      if (now - at >= RECONCILE_INTERVAL_MS) lastReconcileAttempt.delete(id);
    }
    // Still full of recent entries: drop the oldest (insertion order) to stay bounded.
    if (lastReconcileAttempt.size >= RECONCILE_MAX_TRACKED) {
      const oldest = lastReconcileAttempt.keys().next().value;
      if (oldest !== undefined) lastReconcileAttempt.delete(oldest);
    }
  }
  lastReconcileAttempt.set(sessionId, now);
  return true;
}

// Returns the ledger row to report: the refreshed row if Stripe moved it, else
// the stored row. Never throws; any Stripe or DB failure degrades to the stored row.
async function reconcileStaleCheckout(
  row: typeof paymentLedger.$inferSelect,
  request: FastifyRequest
): Promise<typeof paymentLedger.$inferSelect> {
  const sessionId = row.stripeSessionId;
  const now = Date.now();
  if (!sessionId || now - row.createdAt.getTime() < RECONCILE_MIN_AGE_MS) return row;
  // Best-effort read on a public, polled endpoint: honour an open Stripe breaker
  // but run the lookup outside it. Routing it through withStripeCircuit would
  // count its failures (timeouts, 4xx for an inaccessible account) towards the
  // breaker that guards payment creation and could open it for every merchant.
  if (getCircuitBreakerStates().stripe.open) return row;
  if (!shouldAttemptReconcile(sessionId, now)) return row;

  try {
    const session = await stripe.checkout.sessions.retrieve(
      sessionId,
      {},
      {
        stripeAccount: row.connectedAccountId,
        timeout: RECONCILE_STRIPE_TIMEOUT_MS,
        maxNetworkRetries: 0,
      }
    );
    // An open session has nothing to apply yet.
    const outcome =
      session.status === "complete" ? "completed" : session.status === "expired" ? "expired" : null;
    if (!outcome) return row;

    // Reconciliation is not a Stripe event, so it must not advance the ordering
    // clock (a later, genuinely newer webhook would be discarded as stale) nor
    // lose to it. Reuse the newest event time already recorded on the row.
    const eventCreatedAt = Math.max(session.created, row.lastStripeEventCreatedAt ?? 0);
    await applyCheckoutSessionOutcome(outcome, session, eventCreatedAt, request.log);

    const [updated] = await db
      .select()
      .from(paymentLedger)
      .where(eq(paymentLedger.id, row.id))
      .limit(1);
    return updated ?? row;
  } catch (err) {
    request.log.warn({ err, sessionId }, "Checkout status reconciliation with Stripe failed");
    return row;
  }
}

interface RequestWithClient extends FastifyRequest {
  client?: typeof clients.$inferSelect;
}

async function requireClientOrAdmin(request: FastifyRequest, reply: FastifyReply) {
  const apiKeyHeader = request.headers["x-api-key"];

  interface ReplyMock {
    sent: boolean;
    statusCode: number;
    code(n: number): ReplyMock;
    status(n: number): ReplyMock;
    send(p: unknown): ReplyMock;
  }

  const runAuthCheck = async (
    checker: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  ) => {
    const state: { sent: boolean; statusCode: number; payload: unknown } = {
      sent: false,
      statusCode: 200,
      payload: undefined,
    };

    const replyMock: ReplyMock = {
      sent: false,
      statusCode: 200,
      code(code: number) {
        state.statusCode = code;
        this.statusCode = code;
        return this;
      },
      status(code: number) {
        state.statusCode = code;
        this.statusCode = code;
        return this;
      },
      send(payload: unknown) {
        state.sent = true;
        state.payload = payload;
        this.sent = true;
        return this;
      },
    };

    await checker(request, replyMock as unknown as FastifyReply);
    return state;
  };

  if (apiKeyHeader) {
    const apiKeyResult = await runAuthCheck(requireApiKey);
    if ((request as RequestWithClient).client) return;
    if (apiKeyResult.statusCode >= 500) {
      return reply.code(apiKeyResult.statusCode).send(apiKeyResult.payload);
    }
    if (!request.headers.authorization) {
      return reply
        .code(apiKeyResult.sent ? apiKeyResult.statusCode : 401)
        .send(apiKeyResult.payload ?? { error: "Authentication required (API Key or Admin JWT)." });
    }
  }

  const adminResult = await runAuthCheck(requireAdminJwt);
  if (!adminResult.sent) return;
  return reply.code(adminResult.statusCode).send(adminResult.payload);
}

function extractIdempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers["idempotency-key"];
  return Array.isArray(key) ? key[0] : key;
}

function resolvePaymentRateLimitKey(request: FastifyRequest): string {
  const req = request as RequestWithClient;
  if (req.client?.stripeAccountId) {
    return `stripe:${req.client.stripeAccountId}`;
  }
  return getClientIp(request);
}

// ── Session status auth + limits ───────────────────────────────────────────────
// The endpoint stays anonymous (per-IP limit). Sending X-Api-Key opts into API-key auth and a
// higher per-client limit; a bad key is a 401, never a silent fall back to anonymous, and failed
// attempts are limited per IP.
const anonymousStatusRateLimit = rateLimit({
  max: SESSION_STATUS_ANONYMOUS_RATE_LIMIT_MAX,
  windowMs: 60_000,
});
const apiKeyStatusRateLimit = rateLimit({
  max: SESSION_STATUS_API_KEY_RATE_LIMIT_MAX,
  windowMs: 60_000,
  // Own bucket namespace: never shares hits with the anonymous per-IP limiter.
  name: "GET:/payments/session/:sessionId:api-key",
  keyGenerator: (request) => `client:${(request as RequestWithClient).client?.id}`,
});

// Failed key authentications are limited per caller IP by DISTINCT key (the key's SHA-256 lookup
// is the member), so a flood of junk keys turns into 429s instead of unlimited database lookups
// while one bad key polled in a loop still uses a single unit. The unit is charged before the
// lookup, atomically, and given back when the key turns out to be valid or the lookup errors.
const failedStatusAuthLimit = failureRateLimit({
  max: SESSION_STATUS_FAILED_AUTH_RATE_LIMIT_MAX,
  windowMs: 60_000,
  name: "GET:/payments/session/:sessionId:failed-auth",
});

async function sessionStatusGuard(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers["x-api-key"];
  if (header === undefined) {
    return anonymousStatusRateLimit(request, reply);
  }

  const apiKey = Array.isArray(header) ? header[0] : header;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    // A missing or blank key never reaches the database, so it is not counted.
    await requireApiKey(request, reply);
    return reply;
  }

  // Reserve one unit of the IP's failed-auth budget for this key before looking it up. A key
  // already counted this window (a repeat) costs nothing more. Over budget, the request is
  // refused with no lookup, except a key that passed verification within the last minute: that
  // exception keeps one IP's junk keys from locking out its working ones, and such a key is
  // only charged after the fact if it turns out to have been rejected. The cache only vouches
  // for the key's recent past, so requireApiKey below still loads the client row and rejects a
  // client that has since been deactivated.
  const lookup = sha256Lookup(apiKey);
  let charge: Extract<FailureCharge, { blocked: false }> | undefined;
  if (!isRecentlyVerifiedApiKey(apiKey)) {
    const result = await failedStatusAuthLimit.charge(request, lookup);
    if (result.blocked) return sendRateLimited(reply, result.retryAfterMs);
    charge = result;
  }

  // Only a rejected key (401) stays counted. A key that is accepted, or a 500 from our own
  // database error, is not the caller's failure and gives the unit back.
  let rejected = false;
  try {
    await requireApiKey(request, reply);
    rejected = reply.sent && reply.statusCode === 401;
  } finally {
    if (!rejected) {
      await charge?.release();
    } else if (charge) {
      charge.keep();
    } else {
      await failedStatusAuthLimit.record(request, lookup);
    }
  }
  if (reply.sent) return reply;
  return apiKeyStatusRateLimit(request, reply);
}

const STRIPE_CIRCUIT_OPEN_ERROR = {
  error: "Payment service is temporarily unavailable.",
  code: "STRIPE_CIRCUIT_OPEN",
};

// ── Strict line-item schema ────────────────────────────────────────────────────
// Only inline price_data is accepted. Stripe price IDs (platform-scoped) are
// incompatible with connected-account Checkout sessions and are rejected.
const CURRENCY_REGEX = /^[a-z]{3}$/;
const MAX_SAFE_AMOUNT = 99_999_999; // Stripe max for most currencies is 99999999

const lineItemSchema = z.object({
  price_data: z.object({
    currency: z
      .string()
      .transform((v) => v.toLowerCase())
      .refine((v) => CURRENCY_REGEX.test(v), {
        message: "currency must be a 3-letter ISO code (e.g. 'usd').",
      }),
    product_data: z.object({
      name: z.string().min(1, "product name is required.").max(200),
      description: z.string().max(1000).optional(),
    }),
    unit_amount: z
      .number()
      .int("unit_amount must be an integer.")
      .positive("unit_amount must be positive.")
      .max(MAX_SAFE_AMOUNT, `unit_amount must not exceed ${MAX_SAFE_AMOUNT}.`),
  }),
  quantity: z
    .number()
    .int("quantity must be an integer.")
    .positive("quantity must be positive.")
    .max(999_999)
    .default(1),
});

// ── Metadata validation ────────────────────────────────────────────────────────
// Stripe allows max 50 metadata keys, each key max 40 chars, each value max 500 chars.
const STRIPE_METADATA_MAX_KEYS = 50;
const STRIPE_METADATA_MAX_KEY_LENGTH = 40;
const STRIPE_METADATA_MAX_VALUE_LENGTH = 500;

function validateStripeMetadata(
  metadata: Record<string, string> | undefined
): Record<string, string> {
  if (!metadata) return {};
  const keys = Object.keys(metadata);
  if (keys.length > STRIPE_METADATA_MAX_KEYS) {
    throw errors.badRequest(`metadata must not exceed ${STRIPE_METADATA_MAX_KEYS} keys.`);
  }
  for (const key of keys) {
    if (key.length > STRIPE_METADATA_MAX_KEY_LENGTH) {
      throw errors.badRequest(
        `metadata key '${key.slice(0, 20)}...' exceeds ${STRIPE_METADATA_MAX_KEY_LENGTH} characters.`
      );
    }
    if (metadata[key].length > STRIPE_METADATA_MAX_VALUE_LENGTH) {
      throw errors.badRequest(
        `metadata value for '${key}' exceeds ${STRIPE_METADATA_MAX_VALUE_LENGTH} characters.`
      );
    }
  }
  return metadata;
}

const paymentCreateBodySchema = z.object({
  amount: z.number().optional(),
  currency: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() : v)),
  description: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  lineItems: z.array(lineItemSchema).optional(),
  waiveFee: z.boolean().optional(),
  workspace: z.string().optional(),
  clientId: z.string().optional(),
});

// ── Ledger insert helper ───────────────────────────────────────────────────────
// Inserts a payment ledger row after Stripe creation.
// CRITICAL: This MUST succeed before returning the payment URL/secret to the caller.
// If Stripe succeeds but DB insert fails, we return a 503 and the caller can retry
// with the same idempotency key — Stripe will return the existing object and we
// can then insert the ledger row.
// Idempotency keys are scoped per client: (client_id, idempotency_key) and
// stripe_session_id are both unique. A conflict on either is not an error by
// itself, so the helper reports whether the session is recorded under this
// client's key: "recorded" (inserted, or an identical retry) or "key_reused"
// (the key already belongs to a different session). Any other state throws so
// the caller never returns a session that has no ledger row.
async function insertPaymentLedger(row: {
  id: string;
  idempotencyKey: string;
  connectedAccountId: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  clientId: string;
  source: "checkout" | "payment_intent";
  status: "created" | "paid" | "expired" | "failed" | "refunded" | "disputed" | "canceled";
  baseAmountCents: number;
  totalAmountCents: number;
  feeAmountCents: number;
  refundedAmountCents: number;
  currency: string;
  metadata: string | null;
}): Promise<"recorded" | "key_reused"> {
  const inserted = await db
    .insert(paymentLedger)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: paymentLedger.id });
  if (inserted.length > 0) return "recorded";

  const [existing] = await db
    .select({ stripeSessionId: paymentLedger.stripeSessionId })
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.clientId, row.clientId),
        eq(paymentLedger.idempotencyKey, row.idempotencyKey)
      )
    )
    .limit(1);
  if (!existing) {
    // Conflicted on stripe_session_id under a different client/key: the session
    // is not recorded for this request.
    throw new Error("Ledger conflict without a matching row for this client and key");
  }
  return existing.stripeSessionId === row.stripeSessionId ? "recorded" : "key_reused";
}

export default async function paymentsRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/payments/create",
    {
      preHandler: [
        requireClientOrAdmin,
        tokenBucketRateLimit({
          capacity: PAYMENT_CREATE_BUCKET_CAPACITY,
          refillPerMinute: PAYMENT_CREATE_REFILL_PER_MINUTE,
          keyGenerator: resolvePaymentRateLimitKey,
        }),
      ],
    },
    async (request, reply) => {
      const idempotencyKeyHeader = extractIdempotencyKey(request);
      // Require nonblank Idempotency-Key for ALL payment creation (API-key and admin).
      if (!idempotencyKeyHeader || idempotencyKeyHeader.trim().length === 0) {
        throw errors.badRequest("Idempotency-Key header is required.");
      }
      const idempotencyKey = idempotencyKeyHeader.trim();
      const isApiCall = !!request.headers["x-api-key"];

      const body = parseBody(paymentCreateBodySchema, request.body, reply);
      if (!body) return;
      const {
        currency,
        description,
        metadata: rawMetadata,
        lineItems,
        waiveFee = false,
        workspace,
      } = body as Omit<typeof body, "lineItems"> & {
        lineItems?: z.infer<typeof lineItemSchema>[];
      };

      const userMetadata = validateStripeMetadata(rawMetadata);

      let client = (request as RequestWithClient).client;

      if (!client) {
        const validWorkspace = validateWorkspace(workspace, reply);
        if (!validWorkspace) return;
        const bodyClientId = body.clientId || userMetadata?.clientId;
        if (!bodyClientId) {
          throw errors.badRequest("clientId is required when using Admin authentication.");
        }
        [client] = await db.select().from(clients).where(eq(clients.id, bodyClientId)).limit(1);
      }

      if (!client) {
        throw errors.notFound("Client");
      }

      if (!client.stripeAccountId || !client.chargesEnabled) {
        return reply.code(409).send({
          error: "Client Stripe account is not connected or cannot accept charges.",
          code: "ACCOUNT_NOT_CONNECTED",
        });
      }

      const effectiveWaiveFee = isApiCall ? false : waiveFee;

      if (!isApiCall && workspace && client.workspace !== workspace) {
        throw errors.badRequest("clientId does not belong to the selected workspace.");
      }

      const clientId = client.id;
      const stripeAccountId = client.stripeAccountId;

      // Keys are scoped per client: namespace the key sent to Stripe so two
      // clients using the same key never collide on the platform. Stripe limits
      // idempotency keys to 255 characters, so the namespaced key must fit.
      const stripeIdempotencyKey = `${clientId}:${idempotencyKey}`;
      if (stripeIdempotencyKey.length > 255) {
        throw errors.badRequest(
          `Idempotency-Key must not exceed ${255 - clientId.length - 1} characters.`
        );
      }

      const group = client.groupId
        ? ((
            await db.select().from(clientGroups).where(eq(clientGroups.id, client.groupId)).limit(1)
          )[0] ?? null)
        : null;

      // ── Checkout flow ──────────────────────────────────────────────────────
      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        throw errors.badRequest("lineItems are required.");
      }

      if (lineItems.length > 100) {
        throw errors.badRequest("lineItems must not exceed 100 items.");
      }

      // Derive baseAmount strictly from line items server-side.
      // The caller-supplied `amount` is ignored for Checkout to prevent fee
      // integrity attacks where a caller sends a lower amount than the line
      // items imply.
      let baseAmount = 0;
      let lineItemCurrency: string | undefined;
      for (const item of lineItems) {
        const unitAmount = item.price_data.unit_amount;
        const qty = item.quantity;
        const lineTotal = unitAmount * qty;
        if (!Number.isSafeInteger(lineTotal) || lineTotal > MAX_SAFE_AMOUNT * 999_999) {
          throw errors.badRequest("Line item total exceeds safe integer bounds.");
        }
        baseAmount += lineTotal;
        if (!lineItemCurrency) {
          lineItemCurrency = item.price_data.currency;
        } else if (lineItemCurrency !== item.price_data.currency) {
          throw errors.badRequest("All line items must use the same currency.");
        }
      }

      if (baseAmount <= 0) {
        throw errors.badRequest("Computed base amount must be positive.");
      }

      if (!Number.isSafeInteger(baseAmount)) {
        throw errors.badRequest("Computed base amount exceeds safe integer bounds.");
      }

      const resolvedCurrency = lineItemCurrency ?? currency;
      if (!resolvedCurrency || !CURRENCY_REGEX.test(resolvedCurrency)) {
        throw errors.badRequest("currency must be a 3-letter ISO code (e.g. 'usd').");
      }

      let feeAmount: number;
      try {
        feeAmount = await resolveClientFee(client, group, baseAmount);
      } catch (e: unknown) {
        throw errors.badRequest((e as Error).message);
      }

      if (!Number.isSafeInteger(feeAmount) || feeAmount < 0) {
        throw errors.badRequest("Computed fee is invalid.");
      }

      const checkoutLineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = lineItems.map(
        (item) => ({
          price_data: {
            currency: item.price_data.currency,
            product_data: {
              name: item.price_data.product_data.name,
              ...(item.price_data.product_data.description
                ? { description: item.price_data.product_data.description }
                : {}),
            },
            unit_amount: item.price_data.unit_amount,
          },
          quantity: item.quantity,
        })
      );

      if (feeAmount > 0 && !effectiveWaiveFee) {
        checkoutLineItems.push({
          price_data: {
            currency: resolvedCurrency,
            product_data: {
              name: "Processing Fee",
            },
            unit_amount: feeAmount,
          },
          quantity: 1,
        });
      }

      const totalAmount = effectiveWaiveFee ? baseAmount : baseAmount + feeAmount;

      const defaultSuccessUrl = resolveDefaultPaymentSuccessUrl();
      const defaultCancelUrl = resolveDefaultPaymentCancelUrl();
      const successUrl = client.paymentSuccessUrl ?? group?.paymentSuccessUrl ?? defaultSuccessUrl;
      const cancelUrl = client.paymentCancelUrl ?? group?.paymentCancelUrl ?? defaultCancelUrl;
      const frontendOrigin = successUrl && cancelUrl ? undefined : resolveFrontendOrigin();

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: "payment",
        line_items: checkoutLineItems,
        success_url: appendCheckoutSessionId(
          successUrl ?? `${frontendOrigin}/payment-success?session_id={CHECKOUT_SESSION_ID}`
        ),
        cancel_url: cancelUrl ?? `${frontendOrigin}/payment-cancel`,
        payment_intent_data: {
          description,
          metadata: {
            ...userMetadata,
            clientId,
            baseAmount: baseAmount.toString(),
            feeAmount: effectiveWaiveFee ? "0" : feeAmount.toString(),
            waivedFeeAmount: effectiveWaiveFee ? feeAmount.toString() : "0",
          },
        },
        metadata: {
          clientId,
        },
      };

      let session: Stripe.Checkout.Session;
      try {
        if (sessionParams.payment_intent_data && !effectiveWaiveFee) {
          sessionParams.payment_intent_data.application_fee_amount = feeAmount;
        }
        session = await withStripeCircuit(() =>
          stripe.checkout.sessions.create(sessionParams, {
            stripeAccount: stripeAccountId,
            idempotencyKey: stripeIdempotencyKey,
          })
        );
      } catch (err) {
        request.log.error({ err }, "Stripe Checkout session creation failed");
        if (
          mapStripeError(err, reply, {
            circuitOpen: STRIPE_CIRCUIT_OPEN_ERROR,
            cardDeclinedCode: "CARD_DECLINED",
            rateLimited: { error: "Payment service is busy. Please retry.", code: "RATE_LIMITED" },
            permanentErrors: true,
          })
        )
          return;
        throw errors.stripeFailed("Payment processing failed. Please try again.");
      }

      // CRITICAL: Persist ledger synchronously BEFORE returning the checkout URL.
      // If this fails, we return 503 — the caller can retry with the same
      // idempotency key and Stripe will return the existing session.
      let ledgerResult: "recorded" | "key_reused";
      try {
        ledgerResult = await insertPaymentLedger({
          id: uuidv4(),
          idempotencyKey,
          connectedAccountId: stripeAccountId,
          stripeSessionId: session.id,
          stripePaymentIntentId: null,
          clientId,
          source: "checkout",
          status: "created",
          baseAmountCents: baseAmount,
          totalAmountCents: totalAmount,
          feeAmountCents: effectiveWaiveFee ? 0 : feeAmount,
          refundedAmountCents: 0,
          currency: resolvedCurrency,
          metadata: Object.keys(userMetadata).length > 0 ? JSON.stringify(userMetadata) : null,
        });
      } catch (err) {
        request.log.error(
          { err, stripeSessionId: session.id },
          "Ledger insert failed after Stripe Checkout session creation — returning 503"
        );
        return reply.code(503).send({
          error:
            "Payment recorded but confirmation failed. Please retry with the same Idempotency-Key.",
          code: "LEDGER_PERSISTENCE_FAILED",
        });
      }

      if (ledgerResult === "key_reused") {
        request.log.warn(
          { clientId, stripeSessionId: session.id },
          "Idempotency-Key already used for a different payment session"
        );
        return reply.code(409).send({
          error:
            "This Idempotency-Key was already used for a different payment. Use a new unique key for each new payment.",
          code: "IDEMPOTENCY_KEY_REUSED",
        });
      }

      return reply.code(201).send({ url: session.url, sessionId: session.id });
    }
  );

  // ── GET /payments/session/:sessionId ─────────────────────────────────────────
  // Rate-limited endpoint for retrieving checkout session result; anonymous by default, or with
  // an X-Api-Key (see sessionStatusGuard). Uses the payment ledger as primary source. Returns
  // only payer-safe fields.
  fastify.get(
    "/payments/session/:sessionId",
    {
      preHandler: [sessionStatusGuard],
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      if (!sessionId || !/^cs_(test_|live_)[A-Za-z0-9_]+$/.test(sessionId)) {
        throw errors.badRequest("Invalid session ID format.");
      }

      // Primary: look up in ledger.
      const [ledgerRow] = await db
        .select()
        .from(paymentLedger)
        .where(eq(paymentLedger.stripeSessionId, sessionId))
        .limit(1);

      // An authenticated caller only sees its own client's sessions; another client's session
      // is indistinguishable from an unknown one.
      const caller = (request as RequestWithClient).client;
      if (ledgerRow && (!caller || ledgerRow.clientId === caller.id)) {
        // A row still "created" after the webhook should have landed means the
        // event may have been lost; ask Stripe and apply the same transition.
        const current =
          ledgerRow.status === "created"
            ? await reconcileStaleCheckout(ledgerRow, request)
            : ledgerRow;
        return reply.send({
          status: current.status,
          baseAmountCents: current.baseAmountCents,
          totalAmountCents: current.totalAmountCents,
          feeAmountCents: current.feeAmountCents,
          currency: current.currency,
          createdAt: current.createdAt,
        });
      }

      // Fallback: retrieve from Stripe using stored connected account context.
      // We need to find which connected account this session belongs to.
      // Without a ledger row, we cannot determine the connected account,
      // so we return 404 rather than guessing.
      throw errors.notFound("Payment session");
    }
  );

  fastify.get(
    "/reports/payments",
    {
      preHandler: [
        requireAdminJwt,
        adminRateLimit({
          max: 60,
          windowMs: 60_000,
        }),
      ],
    },
    async (request, reply) => {
      const { clientId, groupId, workspace, limit, starting_after, ending_before } =
        request.query as {
          clientId?: string;
          groupId?: string;
          workspace?: string;
          limit?: string;
          starting_after?: string;
          ending_before?: string;
        };

      const validWorkspace = validateWorkspaceQuery(workspace, reply);
      if (!validWorkspace) return;

      if (!clientId && !groupId) {
        throw errors.badRequest("clientId or groupId query parameter is required.");
      }

      let parsedLimit: number | undefined;
      if (limit) {
        parsedLimit = Number(limit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
          throw errors.badRequest("limit must be an integer between 1 and 100.");
        }
      }

      const listParams: Stripe.PaymentIntentListParams = {};
      if (parsedLimit !== undefined) listParams.limit = parsedLimit;
      if (starting_after) listParams.starting_after = starting_after;
      if (ending_before) listParams.ending_before = ending_before;

      if (groupId) {
        const [group] = await db
          .select()
          .from(clientGroups)
          .where(eq(clientGroups.id, groupId))
          .limit(1);
        if (!group) {
          throw errors.badRequest("Invalid groupId.");
        }
        const groupClients = await db
          .select()
          .from(clients)
          .where(and(eq(clients.groupId, groupId), eq(clients.workspace, validWorkspace)));

        const connected = groupClients.filter(
          (c): c is typeof c & { stripeAccountId: string } => c.stripeAccountId !== null
        );
        if (connected.length === 0) {
          return reply.send({ groupId, data: [], hasMore: false });
        }
        // Cursors (starting_after/ending_before) are per-account and cannot be
        // forwarded across accounts, so only the limit is applied per account.
        const perAccountParams: Stripe.PaymentIntentListParams = {};
        if (parsedLimit !== undefined) perAccountParams.limit = parsedLimit;

        const maxConcurrency = REPORT_MAX_CONCURRENCY;
        const results: Array<Record<string, unknown>[]> = [];
        const failedAccounts: string[] = [];
        let hasMore = false;
        for (let i = 0; i < connected.length; i += maxConcurrency) {
          const batch = connected.slice(i, i + maxConcurrency);
          const settled = await Promise.allSettled(
            batch.map(async (c) => {
              const pi = await withStripeCircuit(() =>
                stripe.paymentIntents.list(perAccountParams, {
                  stripeAccount: c.stripeAccountId,
                })
              );
              return { pi, client: c };
            })
          );
          for (let j = 0; j < settled.length; j++) {
            const outcome = settled[j];
            if (outcome.status === "fulfilled") {
              const { pi, client: c } = outcome.value;
              if (pi.has_more) hasMore = true;
              results.push(
                pi.data.map((p) => sanitizePaymentIntent(p, { clientId: c.id, clientName: c.name }))
              );
            } else {
              const c = batch[j];
              if (mapStripeError(outcome.reason, reply, { circuitOpen: STRIPE_CIRCUIT_OPEN_ERROR }))
                return;
              failedAccounts.push(c.id);
              request.log.error(
                { err: outcome.reason, clientId: c.id, stripeAccountId: c.stripeAccountId },
                "Failed to list payments for connected account; excluding from group report"
              );
            }
          }
        }
        const merged = results.flat();
        return reply.send({
          groupId,
          data: merged,
          hasMore,
          ...(failedAccounts.length > 0 ? { partial: true, failedClientIds: failedAccounts } : {}),
        });
      }

      if (!clientId) {
        throw errors.badRequest("clientId query parameter is required.");
      }
      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      if (!client) {
        throw errors.notFound("Client");
      }
      if (client.workspace !== workspace) {
        throw errors.badRequest("clientId does not belong to the selected workspace.");
      }

      if (!client.stripeAccountId) {
        throw errors.notFound("Client with connected account");
      }
      const stripeAccountId = client.stripeAccountId;
      let paymentIntents: Awaited<ReturnType<typeof stripe.paymentIntents.list>>;
      try {
        paymentIntents = await withStripeCircuit(() =>
          stripe.paymentIntents.list(listParams, {
            stripeAccount: stripeAccountId,
          })
        );
      } catch (err) {
        request.log.error({ err, clientId }, "Stripe PaymentIntent list failed");
        if (mapStripeError(err, reply, { circuitOpen: STRIPE_CIRCUIT_OPEN_ERROR })) return;
        return reply.code(502).send({ error: "Failed to list payments." });
      }

      return reply.send({
        clientId,
        data: paymentIntents.data.map((p) => sanitizePaymentIntent(p)),
        hasMore: paymentIntents.has_more,
      });
    }
  );
}
