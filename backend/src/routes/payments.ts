import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt, requireApiKey } from "../lib/auth";
import { rateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { resolveClientFee } from "../lib/stripe-billing";
import { isWorkspace } from "../lib/workspace";

interface RequestWithClient extends FastifyRequest {
  client?: typeof clients.$inferSelect;
}

/**
 * Flexible auth: Try API key first, then try Admin JWT.
 * Distinguishes auth failures (returned 401) from system errors (thrown).
 */
async function requireClientOrAdmin(request: FastifyRequest, reply: FastifyReply) {
  const apiKeyHeader = request.headers["x-api-key"];
  let authError = false;

  // 1. Try API Key if header exists
  if (apiKeyHeader) {
    try {
      await requireApiKey(request, reply);
    } catch {
      throw new Error("System error during API key validation");
    }
    if ((request as RequestWithClient).client) return;

    // API key auth failed (returned 401 but didn't throw) - try JWT
    const initialSent = reply.sent;
    if (initialSent && reply.statusCode === 401) {
      authError = true;
      // Reset reply for next attempt
      reply.sent = false;
    }
  }

  // 2. Try Admin JWT
  if (!(request as RequestWithClient).client) {
    try {
      await requireAdminJwt(request, reply);
    } catch {
      throw new Error("System error during JWT validation");
    }
    if ((request as RequestWithClient).client) return;

    // Both failed
    if (reply.sent && reply.statusCode === 401) {
      authError = true;
    }
    if (!authError) {
      return reply.code(401).send({ error: "Authentication required (API Key or Admin JWT)." });
    }
  }
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
  // Compute useCheckout flag at route registration time
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
      const idempotencyKey = extractIdempotencyKey(request);
      const isApiCall = !!request.headers["x-api-key"];
      if (isApiCall && (!idempotencyKey || idempotencyKey.trim().length === 0)) {
        return reply.code(400).send({ error: "Idempotency-Key header is required for API calls." });
      }

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

      // If no client resolved from API key, but user is Admin, resolve from body.clientId or metadata.clientId
      if (!client) {
        if (!isWorkspace(workspace)) {
          return reply
            .code(400)
            .send({ error: "workspace is required for admin payment creation." });
        }
        const bodyClientId = (request.body as { clientId?: string }).clientId || metadata?.clientId;
        if (!bodyClientId) {
          return reply
            .code(400)
            .send({ error: "clientId is required when using Admin authentication." });
        }
        [client] = await db.select().from(clients).where(eq(clients.id, bodyClientId)).limit(1);
      }

      if (!client) {
        return reply.code(404).send({ error: "Client not found." });
      }

      if (!isApiCall && workspace && client.workspace !== workspace) {
        return reply
          .code(400)
          .send({ error: "clientId does not belong to the selected workspace." });
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
          return reply
            .code(400)
            .send({ error: "amount and currency are required for PaymentIntents." });
        }

        let feeAmount: number;
        try {
          feeAmount = await resolveClientFee(client, group, amount);
        } catch (e: unknown) {
          return reply.code(400).send({ error: (e as Error).message });
        }

        // FEE ON TOP: The customer pays base + fee.
        // If waived, customer only pays base.
        const totalAmount = waiveFee ? amount : amount + feeAmount;

        const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
          amount: totalAmount,
          currency,
          automatic_payment_methods: { enabled: true },
          description,
          metadata: {
            ...(metadata ?? {}),
            clientId,
            baseAmount: amount.toString(),
            feeAmount: waiveFee ? "0" : feeAmount.toString(),
            waivedFeeAmount: waiveFee ? feeAmount.toString() : "0",
          },
        };

        if (stripeAccountId) {
          if (!waiveFee) {
            paymentIntentParams.application_fee_amount = feeAmount;
          }
          const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams, {
            stripeAccount: stripeAccountId,
            idempotencyKey,
          });
          return reply.code(201).send({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
          });
        }

        // Direct payment to Platform account
        const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams, {
          idempotencyKey,
        });
        return reply.code(201).send({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
        });
      }

      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        return reply.code(400).send({ error: "lineItems are required when USE_CHECKOUT=true." });
      }

      // For Checkout, we need to calculate total base amount from line items if 'amount' isn't provided
      let baseAmount = amount ?? 0;
      const hasExplicitAmount = typeof amount === "number" && amount > 0;
      if (!hasExplicitAmount) {
        baseAmount = lineItems.reduce((acc, item) => {
          const unitAmount = item.price_data?.unit_amount;
          if (typeof unitAmount !== "number" || unitAmount <= 0) {
            request.log.warn(
              { item: { price_data: item.price_data, price: item.price } },
              "Line item missing unit_amount - using price ID requires explicit amount"
            );
          }
          return acc + (typeof unitAmount === "number" ? unitAmount : 0) * (item.quantity || 1);
        }, 0);
      }

      if (baseAmount <= 0) {
        return reply.code(400).send({
          error:
            "amount must be provided when line items use price IDs, or line items must have unit_amount.",
        });
      }

      let feeAmount: number;
      try {
        feeAmount = await resolveClientFee(client, group, baseAmount);
      } catch (e: unknown) {
        return reply.code(400).send({ error: (e as Error).message });
      }

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
      if (!frontendOrigin) {
        return reply.code(500).send({ error: "FRONTEND_ORIGIN is not configured." });
      }

      // FEE ON TOP for Checkout: add a "Processing Fee" line item
      const checkoutLineItems = [...lineItems];
      if (feeAmount > 0) {
        checkoutLineItems.push({
          price_data: {
            currency: lineItems[0].price_data?.currency || "usd",
            product_data: {
              name: waiveFee ? "Processing Fee (Waived)" : "Processing Fee",
            },
            unit_amount: waiveFee ? 0 : feeAmount,
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
            feeAmount: waiveFee ? "0" : feeAmount.toString(),
            waivedFeeAmount: waiveFee ? feeAmount.toString() : "0",
          },
        },
        metadata: {
          clientId,
        },
      };

      if (stripeAccountId) {
        if (sessionParams.payment_intent_data && !waiveFee) {
          sessionParams.payment_intent_data.application_fee_amount = feeAmount;
        }
        const session = await stripe.checkout.sessions.create(sessionParams, {
          stripeAccount: stripeAccountId,
          idempotencyKey,
        });
        return reply.code(201).send({ url: session.url });
      }

      // Direct payment
      const session = await stripe.checkout.sessions.create(sessionParams, {
        idempotencyKey,
      });
      return reply.code(201).send({ url: session.url });
    }
  );

  fastify.get("/reports/payments", { preHandler: requireAdminJwt }, async (request, reply) => {
    const { clientId, groupId, workspace, limit, starting_after, ending_before } =
      request.query as {
        clientId?: string;
        groupId?: string;
        workspace?: string;
        limit?: string;
        starting_after?: string;
        ending_before?: string;
      };

    if (!isWorkspace(workspace)) {
      return reply
        .code(400)
        .send({ error: "workspace query parameter is required (dfwsc_services|client_portal)." });
    }

    if (!clientId && !groupId) {
      return reply.code(400).send({ error: "clientId or groupId query parameter is required." });
    }

    let parsedLimit: number | undefined;
    if (limit) {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        return reply.code(400).send({ error: "limit must be an integer between 1 and 100." });
      }
    }

    const listParams: Stripe.PaymentIntentListParams = {};
    if (parsedLimit !== undefined) listParams.limit = parsedLimit;
    if (starting_after) listParams.starting_after = starting_after;
    if (ending_before) listParams.ending_before = ending_before;

    // Group report: aggregate across all clients in the group
    if (groupId) {
      const [group] = await db
        .select()
        .from(clientGroups)
        .where(eq(clientGroups.id, groupId))
        .limit(1);
      if (!group) {
        return reply.code(404).send({ error: "Group not found." });
      }
      if (group.workspace !== workspace) {
        return reply
          .code(400)
          .send({ error: "groupId does not belong to the selected workspace." });
      }

      const groupClients = await db
        .select()
        .from(clients)
        .where(and(eq(clients.groupId, groupId), eq(clients.workspace, workspace)));

      const connected = groupClients.filter(
        (c): c is typeof c & { stripeAccountId: string } => c.stripeAccountId !== null
      );
      if (connected.length === 0) {
        return reply.send({ groupId, data: [], hasMore: false });
      }

      const maxConcurrency = 3;
      const results: Array<Awaited<ReturnType<typeof stripe.paymentIntents.list>>["data"]> = [];
      for (let i = 0; i < connected.length; i += maxConcurrency) {
        const batch = connected.slice(i, i + maxConcurrency);
        const batchResults = await Promise.all(
          batch.map(async (c) => {
            const pi = await stripe.paymentIntents.list(listParams, {
              stripeAccount: c.stripeAccountId,
            });
            return pi.data.map((p) => ({ ...p, clientId: c.id }));
          })
        );
        results.push(...batchResults);
      }

      const merged = results.flat();
      return reply.send({ groupId, data: merged, hasMore: false });
    }

    if (!clientId) {
      return reply.code(400).send({ error: "clientId query parameter is required." });
    }
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!client || !client.stripeAccountId) {
      return reply.code(404).send({ error: "Client with connected account not found." });
    }
    if (client.workspace !== workspace) {
      return reply.code(400).send({ error: "clientId does not belong to the selected workspace." });
    }

    const paymentIntents = await stripe.paymentIntents.list(listParams, {
      stripeAccount: client.stripeAccountId,
    });

    return reply.send({
      clientId,
      data: paymentIntents.data,
      hasMore: paymentIntents.has_more,
    });
  });
}
