import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt, requireApiKey } from "../lib/auth";
import { resolveFrontendOrigin } from "../lib/config";
import { errors } from "../lib/errors";
import { adminRateLimit, rateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { resolveClientFee } from "../lib/stripe-billing";
import { validateWorkspace, validateWorkspaceQuery } from "../lib/validation";

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

export default async function paymentsRoutes(fastify: FastifyInstance) {
  const useCheckout = (process.env.USE_CHECKOUT ?? "false").toLowerCase() === "true";

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
      const isApiCall = !!request.headers["x-api-key"];
      if (isApiCall && (!idempotencyKeyHeader || idempotencyKeyHeader.trim().length === 0)) {
        throw errors.badRequest("Idempotency-Key header is required for API calls.");
      }
      const idempotencyKey = idempotencyKeyHeader ?? randomUUID();

      const {
        amount,
        currency,
        description,
        metadata,
        lineItems,
        waiveFee = false,
        workspace,
      } = request.body as {
        amount?: number;
        currency?: string;
        description?: string;
        metadata?: Record<string, string>;
        lineItems?: Stripe.Checkout.SessionCreateParams.LineItem[];
        waiveFee?: boolean;
        workspace?: string;
      };

      let client = (request as RequestWithClient).client;

      if (!client) {
        const validWorkspace = validateWorkspace(workspace, reply);
        if (!validWorkspace) return;
        const bodyClientId = (request.body as { clientId?: string }).clientId || metadata?.clientId;
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

      if (!useCheckout) {
        if (typeof amount !== "number" || !currency) {
          throw errors.badRequest("amount and currency are required for PaymentIntents.");
        }

        if (!Number.isInteger(amount) || amount <= 0) {
          throw errors.badRequest(
            "amount must be a positive integer (in the smallest currency unit)."
          );
        }

        let feeAmount: number;
        try {
          feeAmount = await resolveClientFee(client, group, amount);
        } catch (e: unknown) {
          throw errors.badRequest((e as Error).message);
        }

        const totalAmount = effectiveWaiveFee ? amount : amount + feeAmount;

        const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
          amount: totalAmount,
          currency,
          automatic_payment_methods: { enabled: true },
          description,
          metadata: {
            ...(metadata ?? {}),
            clientId,
            baseAmount: amount.toString(),
            feeAmount: effectiveWaiveFee ? "0" : feeAmount.toString(),
            waivedFeeAmount: effectiveWaiveFee ? feeAmount.toString() : "0",
          },
        };

        try {
          if (!effectiveWaiveFee) {
            paymentIntentParams.application_fee_amount = feeAmount;
          }
          const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams, {
            stripeAccount: stripeAccountId,
            idempotencyKey,
          });
          return reply.code(201).send({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            stripeAccountId,
          });
        } catch (err) {
          request.log.error({ err }, "Stripe PaymentIntent creation failed");
          if (err instanceof Error && err.name === "StripeCardError") {
            return reply.code(402).send({ error: err.message, code: "CARD_DECLINED" });
          }
          if (err instanceof Error && err.name === "StripeRateLimitError") {
            return reply
              .code(429)
              .send({ error: "Payment service is busy. Please retry.", code: "RATE_LIMITED" });
          }
          throw errors.stripeFailed("Payment processing failed. Please try again.");
        }
      }

      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        throw errors.badRequest("lineItems are required when USE_CHECKOUT=true.");
      }

      const hasExplicitAmount = typeof amount === "number";
      if (hasExplicitAmount && (!Number.isInteger(amount) || (amount as number) <= 0)) {
        throw errors.badRequest(
          "amount must be a positive integer (in the smallest currency unit)."
        );
      }

      let baseAmount = hasExplicitAmount ? (amount as number) : 0;
      if (!hasExplicitAmount) {
        for (const item of lineItems) {
          const unitAmount = item.price_data?.unit_amount;
          if (typeof unitAmount !== "number" || unitAmount <= 0) {
            request.log.warn(
              { item: { price_data: item.price_data, price: item.price } },
              "Line item missing unit_amount - using price ID requires explicit amount"
            );
            throw errors.badRequest(
              "An explicit integer amount is required when any line item references a Stripe price ID."
            );
          }
          baseAmount += unitAmount * (item.quantity || 1);
        }
      }

      if (baseAmount <= 0) {
        throw errors.badRequest(
          "amount must be provided when line items use price IDs, or line items must have unit_amount."
        );
      }

      let feeAmount: number;
      try {
        feeAmount = await resolveClientFee(client, group, baseAmount);
      } catch (e: unknown) {
        throw errors.badRequest((e as Error).message);
      }

      const frontendOrigin = resolveFrontendOrigin();

      const checkoutLineItems = [...lineItems];
      if (feeAmount > 0 && !effectiveWaiveFee) {
        const priceDataCurrencies = new Set(
          lineItems.map((item) => item.price_data?.currency).filter((c): c is string => !!c)
        );
        let feeCurrency: string | undefined;
        if (priceDataCurrencies.size === 1) {
          feeCurrency = [...priceDataCurrencies][0];
        } else if (priceDataCurrencies.size === 0 && currency) {
          feeCurrency = currency;
        }
        if (!feeCurrency) {
          throw errors.badRequest(
            "Unable to determine a consistent currency for the processing fee line item."
          );
        }
        checkoutLineItems.push({
          price_data: {
            currency: feeCurrency,
            product_data: {
              name: "Processing Fee",
            },
            unit_amount: feeAmount,
          },
          quantity: 1,
        });
      }

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: "payment",
        line_items: checkoutLineItems,
        success_url:
          client.paymentSuccessUrl ??
          group?.paymentSuccessUrl ??
          `${frontendOrigin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:
          client.paymentCancelUrl ?? group?.paymentCancelUrl ?? `${frontendOrigin}/payment-cancel`,
        payment_intent_data: {
          description,
          metadata: {
            ...(metadata ?? {}),
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

      try {
        if (sessionParams.payment_intent_data && !effectiveWaiveFee) {
          sessionParams.payment_intent_data.application_fee_amount = feeAmount;
        }
        const session = await stripe.checkout.sessions.create(sessionParams, {
          stripeAccount: stripeAccountId,
          idempotencyKey,
        });
        return reply.code(201).send({ url: session.url });
      } catch (err) {
        request.log.error({ err }, "Stripe Checkout session creation failed");
        if (err instanceof Error && err.name === "StripeCardError") {
          return reply.code(402).send({ error: err.message, code: "CARD_DECLINED" });
        }
        if (err instanceof Error && err.name === "StripeRateLimitError") {
          return reply
            .code(429)
            .send({ error: "Payment service is busy. Please retry.", code: "RATE_LIMITED" });
        }
        throw errors.stripeFailed("Payment processing failed. Please try again.");
      }
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

        const maxConcurrency = 3;
        const results: Array<Awaited<ReturnType<typeof stripe.paymentIntents.list>>["data"]> = [];
        const failedAccounts: string[] = [];
        let hasMore = false;
        for (let i = 0; i < connected.length; i += maxConcurrency) {
          const batch = connected.slice(i, i + maxConcurrency);
          const settled = await Promise.allSettled(
            batch.map(async (c) => {
              const pi = await stripe.paymentIntents.list(perAccountParams, {
                stripeAccount: c.stripeAccountId,
              });
              return { pi, client: c };
            })
          );
          for (let j = 0; j < settled.length; j++) {
            const outcome = settled[j];
            if (outcome.status === "fulfilled") {
              const { pi, client: c } = outcome.value;
              if (pi.has_more) hasMore = true;
              results.push(pi.data.map((p) => ({ ...p, clientId: c.id, clientName: c.name })));
            } else {
              const c = batch[j];
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
      const paymentIntents = await stripe.paymentIntents.list(listParams, {
        stripeAccount: client.stripeAccountId,
      });

      return reply.send({
        clientId,
        data: paymentIntents.data,
        hasMore: paymentIntents.has_more,
      });
    }
  );
}
