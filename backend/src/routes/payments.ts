import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db } from "../db/client";
import { clientGroups, clients, paymentLedger } from "../db/schema";
import { requireAdminJwt, requireApiKey } from "../lib/auth";
import { withStripeCircuit } from "../lib/circuit-breakers";
import {
  resolveDefaultPaymentCancelUrl,
  resolveDefaultPaymentSuccessUrl,
  resolveFrontendOrigin,
} from "../lib/config";
import { REPORT_MAX_CONCURRENCY } from "../lib/constants";
import { errors } from "../lib/errors";
import { adminRateLimit, rateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { resolveClientFee } from "../lib/stripe-billing";
import { mapStripeError } from "../lib/stripe-errors";
import { parseBody, validateWorkspace, validateWorkspaceQuery } from "../lib/validation";

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
  return request.ip || "unknown";
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
// Uses ON CONFLICT DO NOTHING on idempotency_key to handle retries idempotently.
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
}): Promise<void> {
  await db
    .insert(paymentLedger)
    .values(row)
    .onConflictDoNothing({ target: paymentLedger.idempotencyKey });
}

export default async function paymentsRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/payments/create",
    {
      preHandler: [
        requireClientOrAdmin,
        rateLimit({ max: 20, windowMs: 60_000, keyGenerator: resolvePaymentRateLimitKey }),
      ],
    },
    async (request, reply) => {
      const idempotencyKeyHeader = extractIdempotencyKey(request);
      // Require nonblank Idempotency-Key for ALL payment creation (API-key and admin).
      if (!idempotencyKeyHeader || idempotencyKeyHeader.trim().length === 0) {
        throw errors.badRequest("Idempotency-Key header is required.");
      }
      const idempotencyKey = idempotencyKeyHeader.trim();
      // Stripe limits idempotency keys to 255 characters.
      if (idempotencyKey.length > 255) {
        throw errors.badRequest("Idempotency-Key must not exceed 255 characters.");
      }
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
        success_url:
          successUrl ?? `${frontendOrigin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
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
            idempotencyKey,
          })
        );
      } catch (err) {
        request.log.error({ err }, "Stripe Checkout session creation failed");
        if (
          mapStripeError(err, reply, {
            circuitOpen: STRIPE_CIRCUIT_OPEN_ERROR,
            cardDeclinedCode: "CARD_DECLINED",
            rateLimited: { error: "Payment service is busy. Please retry.", code: "RATE_LIMITED" },
          })
        )
          return;
        throw errors.stripeFailed("Payment processing failed. Please try again.");
      }

      // CRITICAL: Persist ledger synchronously BEFORE returning the checkout URL.
      // If this fails, we return 503 — the caller can retry with the same
      // idempotency key and Stripe will return the existing session.
      try {
        await insertPaymentLedger({
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

      return reply.code(201).send({ url: session.url });
    }
  );

  // ── GET /payments/session/:sessionId ─────────────────────────────────────────
  // Rate-limited public endpoint for retrieving checkout session result.
  // Uses the payment ledger as primary source. Returns only payer-safe fields.
  fastify.get(
    "/payments/session/:sessionId",
    {
      preHandler: [rateLimit({ max: 30, windowMs: 60_000 })],
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

      if (ledgerRow) {
        return reply.send({
          status: ledgerRow.status,
          baseAmountCents: ledgerRow.baseAmountCents,
          totalAmountCents: ledgerRow.totalAmountCents,
          feeAmountCents: ledgerRow.feeAmountCents,
          currency: ledgerRow.currency,
          createdAt: ledgerRow.createdAt,
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
