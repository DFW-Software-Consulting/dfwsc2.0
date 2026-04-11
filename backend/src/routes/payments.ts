import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clientGroups, clients, settings } from "../db/schema";
import { requireAdminJwt, requireApiKey } from "../lib/auth";
import { rateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";

function extractIdempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers["idempotency-key"];
  return Array.isArray(key) ? key[0] : key;
}

type RequestWithClient = FastifyRequest & { client?: typeof clients.$inferSelect };

function resolvePaymentRateLimitKey(request: RequestWithClient): string {
  const client = request.client;
  if (client?.stripeAccountId) {
    return `stripe:${client.stripeAccountId}`;
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
    if (typeof amount === "number") {
      return Math.round((amount * parseFloat(dbPercent)) / 100);
    }
  }

  const dbCents = dbDefaultsMap.get("default_fee_cents");
  if (dbCents) {
    return parseInt(dbCents, 10);
  }

  return Number(process.env.DEFAULT_PROCESS_FEE_CENTS ?? 0);
}

async function requireStripeAccountForPayments(request: RequestWithClient, reply: FastifyReply) {
  const client = request.client;
  if (!client) {
    return reply.code(401).send({ error: "API key is required." });
  }
  if (!client.stripeAccountId) {
    return reply.code(400).send({ error: "Client does not have a connected Stripe account." });
  }
}

export default async function paymentsRoutes(fastify: FastifyInstance) {
  // Compute useCheckout flag at route registration time
  const useCheckout = (process.env.USE_CHECKOUT ?? "false").toLowerCase() === "true";
  fastify.post(
    "/payments/create",
    {
      preHandler: [
        requireApiKey,
        requireStripeAccountForPayments,
        rateLimit({ max: 20, windowMs: 60_000, keyGenerator: resolvePaymentRateLimitKey }),
      ],
    },
    async (request, reply) => {
      const idempotencyKey = extractIdempotencyKey(request);
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
        return reply.code(400).send({ error: "Idempotency-Key header is required." });
      }

      const { amount, currency, description, metadata, lineItems } = request.body as {
        amount?: number;
        currency?: string;
        description?: string;
        metadata?: Record<string, string>;
        lineItems?: Stripe.Checkout.SessionCreateParams.LineItem[];
      };

      const client = (request as RequestWithClient).client;
      if (!client) {
        return reply.code(500).send({ error: "Unable to resolve client from API key." });
      }

      const clientId = client.id;

      if (!client.stripeAccountId) {
        return reply.code(400).send({ error: "Client does not have a connected Stripe account." });
      }

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
        if (feeAmount < 0 || feeAmount > amount) {
          return reply
            .code(400)
            .send({ error: "applicationFeeAmount must be between 0 and the payment amount." });
        }

        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount,
            currency,
            automatic_payment_methods: { enabled: true },
            application_fee_amount: feeAmount,
            description,
            metadata: {
              ...(metadata ?? {}),
              clientId,
            },
          },
          { stripeAccount: client.stripeAccountId, idempotencyKey }
        );

        return reply.code(201).send({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
        });
      }

      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        return reply.code(400).send({ error: "lineItems are required when USE_CHECKOUT=true." });
      }

      let feeAmount: number;
      try {
        feeAmount = await resolveClientFee(client, group, amount);
      } catch (e: unknown) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      if (feeAmount < 0) {
        return reply.code(400).send({ error: "applicationFeeAmount must be zero or positive." });
      }

      if (typeof amount === "number" && amount >= 0 && feeAmount > amount) {
        return reply
          .code(400)
          .send({ error: "applicationFeeAmount cannot exceed the total amount." });
      }

      const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
      if (!frontendOrigin) {
        return reply.code(500).send({ error: "FRONTEND_ORIGIN is not configured." });
      }

      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: lineItems,
          success_url:
            client.paymentSuccessUrl ??
            group?.paymentSuccessUrl ??
            `${frontendOrigin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:
            client.paymentCancelUrl ??
            group?.paymentCancelUrl ??
            `${frontendOrigin}/payment-cancel`,
          payment_intent_data: {
            application_fee_amount: feeAmount,
            description,
            metadata: {
              ...(metadata ?? {}),
              clientId,
            },
          },
          metadata: {
            clientId,
          },
        },
        { stripeAccount: client.stripeAccountId, idempotencyKey }
      );

      return reply.code(201).send({ url: session.url });
    }
  );

  fastify.get("/reports/payments", { preHandler: requireAdminJwt }, async (request, reply) => {
    const { clientId, groupId, limit, starting_after, ending_before } = request.query as {
      clientId?: string;
      groupId?: string;
      limit?: string;
      starting_after?: string;
      ending_before?: string;
    };

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

      const groupClients = await db.select().from(clients).where(eq(clients.groupId, groupId));

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
