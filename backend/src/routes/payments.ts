import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clientGroups, clients, settings } from "../db/schema";
import { requireAdminJwt, requireApiKey } from "../lib/auth";
import { rateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { isWorkspace } from "../lib/workspace";

interface RequestWithClient extends FastifyRequest {
  client?: typeof clients.$inferSelect;
}

/**
 * Flexible auth: Try API key first, then try Admin JWT.
 */
async function requireClientOrAdmin(request: FastifyRequest, reply: FastifyReply) {
  // 1. Try API Key if header exists
  if (request.headers["x-api-key"]) {
    try {
      await requireApiKey(request, reply);
      if ((request as RequestWithClient).client) return;
    } catch {
      // Continue to check JWT
    }
  }

  // 2. Try Admin JWT
  try {
    await requireAdminJwt(request, reply);
    return;
  } catch {
    // Both failed
    return reply.code(401).send({ error: "Authentication required (API Key or Admin JWT)." });
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

async function resolveClientFee(
  client: typeof clients.$inferSelect,
  group: typeof clientGroups.$inferSelect | null,
  amount?: number
): Promise<number> {
  if (client.processingFeePercent !== null && client.processingFeePercent !== undefined) {
    if (typeof amount !== "number") {
      throw new Error("amount is required when client uses a percentage-based fee.");
    }
    return Math.round((amount * parseFloat(client.processingFeePercent)) / 100);
  }
  if (client.processingFeeCents !== null && client.processingFeeCents !== undefined) {
    return client.processingFeeCents;
  }
  if (group?.processingFeePercent !== null && group?.processingFeePercent !== undefined) {
    if (typeof amount !== "number") {
      throw new Error("amount is required when group uses a percentage-based fee.");
    }
    return Math.round((amount * parseFloat(group.processingFeePercent)) / 100);
  }
  if (group?.processingFeeCents !== null && group?.processingFeeCents !== undefined) {
    return group.processingFeeCents;
  }

  const dbDefaults = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ["default_fee_percent", "default_fee_cents"]));
  const dbDefaultsMap = new Map(dbDefaults.map((row) => [row.key, row.value]));

  const dbPercent = dbDefaultsMap.get("default_fee_percent");
  if (dbPercent && dbPercent.trim().length > 0) {
    if (typeof amount !== "number") {
      throw new Error("amount is required when using a percentage-based default fee.");
    }
    const parsedPercent = parseFloat(dbPercent);
    if (Number.isNaN(parsedPercent)) {
      throw new Error("Invalid default_fee_percent in database (must be a valid number).");
    }
    return Math.round((amount * parsedPercent) / 100);
  }

  const dbCents = dbDefaultsMap.get("default_fee_cents");
  if (dbCents) {
    return parseInt(dbCents, 10);
  }

  return Number(process.env.DEFAULT_PROCESS_FEE_CENTS ?? 0);
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
      let baseAmount = amount;
      if (typeof baseAmount !== "number") {
        baseAmount = lineItems.reduce((acc, item) => {
          const unitAmount = item.price_data?.unit_amount || 0;
          const quantity = item.quantity || 1;
          return acc + unitAmount * quantity;
        }, 0);
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

      const results = await Promise.all(
        connected.map(async (c) => {
          const pi = await stripe.paymentIntents.list(listParams, {
            stripeAccount: c.stripeAccountId,
          });
          return pi.data.map((p) => ({ ...p, clientId: c.id }));
        })
      );

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
