import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { z } from "zod";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { withStripeCircuit } from "../lib/circuit-breakers";
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../lib/constants";
import { errors } from "../lib/errors";
import { adminRateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { mapStripeError } from "../lib/stripe-errors";
import { parseBody } from "../lib/validation";

interface CreateProductBody {
  name: string;
  description?: string;
  amountCents: number;
  currency?: string;
  clientId: string;
}

function formatProduct(product: Stripe.Product, price: Stripe.Price | null) {
  return {
    id: product.id,
    name: product.name,
    description: product.description ?? null,
    defaultPrice:
      price && price.unit_amount != null
        ? { id: price.id, amountCents: price.unit_amount, currency: price.currency }
        : null,
  };
}

const adminCrudRateLimit = adminRateLimit({
  max: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

const CIRCUIT_OPEN_ERROR = { error: "Stripe service temporarily unavailable." };

const createProductBodySchema = z.object({
  name: z.string({ error: "name is required." }).trim().min(1, "name is required."),
  description: z.string().optional(),
  amountCents: z
    .number({ error: "amountCents must be a positive integer." })
    .int("amountCents must be a positive integer.")
    .positive("amountCents must be a positive integer."),
  currency: z.string().optional(),
  clientId: z.string({ error: "clientId is required." }).min(1, "clientId is required."),
});

const listProductsQuerySchema = z.object({
  clientId: z.string({ error: "clientId is required." }).min(1, "clientId is required."),
});

async function resolveConnectedAccount(clientId: string): Promise<string> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) {
    throw errors.notFound("Client");
  }
  if (!client.stripeAccountId || !client.chargesEnabled) {
    throw errors.badRequest(
      "Client must have a connected Stripe account with charges enabled to manage products."
    );
  }
  return client.stripeAccountId;
}

const productRoutes: FastifyPluginAsync = async (app) => {
  // GET /tax-rates — list active Stripe tax rates for a connected account
  app.get("/tax-rates", { preHandler: [requireAdminJwt, adminCrudRateLimit] }, async (req, res) => {
    const { clientId } = req.query as { clientId?: string };
    if (!clientId) {
      throw errors.badRequest("clientId query parameter is required.");
    }
    const stripeAccountId = await resolveConnectedAccount(clientId);

    let taxRates: Stripe.TaxRate[];
    try {
      ({ data: taxRates } = await withStripeCircuit(() =>
        stripe.taxRates.list(
          {
            active: true,
            limit: 100,
          },
          { stripeAccount: stripeAccountId }
        )
      ));
    } catch (err) {
      if (mapStripeError(err, res, { circuitOpen: CIRCUIT_OPEN_ERROR })) return;
      throw err;
    }

    return res.send(
      taxRates.map((rate) => ({
        id: rate.id,
        displayName: rate.display_name,
        description: rate.description ?? null,
        percentage: rate.percentage,
        inclusive: rate.inclusive,
        jurisdiction: rate.jurisdiction ?? null,
      }))
    );
  });

  // GET /products — list active Stripe products for a connected account
  app.get("/products", { preHandler: [requireAdminJwt, adminCrudRateLimit] }, async (req, res) => {
    const query = listProductsQuerySchema.safeParse(req.query ?? {});
    if (!query.success) {
      throw errors.badRequest(query.error.issues[0]?.message ?? "clientId is required.");
    }
    const stripeAccountId = await resolveConnectedAccount(query.data.clientId);

    let products: Stripe.Product[];
    try {
      ({ data: products } = await withStripeCircuit(() =>
        stripe.products.list(
          {
            active: true,
            limit: 100,
            expand: ["data.default_price"],
          },
          { stripeAccount: stripeAccountId }
        )
      ));
    } catch (err) {
      if (mapStripeError(err, res, { circuitOpen: CIRCUIT_OPEN_ERROR })) return;
      throw err;
    }

    return res.send(
      products.map((p) => {
        const price =
          p.default_price && typeof p.default_price === "object"
            ? (p.default_price as Stripe.Price)
            : null;
        return formatProduct(p, price);
      })
    );
  });

  // POST /products — create Stripe product + price on a connected account
  app.post<{ Body: CreateProductBody }>(
    "/products",
    { preHandler: [requireAdminJwt, adminCrudRateLimit] },
    async (req, res) => {
      const body = parseBody(createProductBodySchema, req.body, res) as CreateProductBody | null;
      if (!body) return;
      const { name, description, amountCents, currency = "usd", clientId } = body;

      const stripeAccountId = await resolveConnectedAccount(clientId);

      // Generate idempotency keys for each Stripe operation.
      const productIdempotencyKey = `prod-${clientId}-${randomUUID()}`;
      const priceIdempotencyKey = `price-${clientId}-${randomUUID()}`;
      const updateIdempotencyKey = `prod-update-${clientId}-${randomUUID()}`;

      let product: Stripe.Product;
      let price: Stripe.Price;
      try {
        product = await withStripeCircuit(() =>
          stripe.products.create(
            {
              name: name.trim(),
              ...(description?.trim() ? { description: description.trim() } : {}),
            },
            { stripeAccount: stripeAccountId, idempotencyKey: productIdempotencyKey }
          )
        );

        try {
          price = await withStripeCircuit(() =>
            stripe.prices.create(
              {
                product: product.id,
                unit_amount: amountCents,
                currency,
              },
              { stripeAccount: stripeAccountId, idempotencyKey: priceIdempotencyKey }
            )
          );
        } catch (priceErr) {
          // Price creation failed — archive the orphaned product to avoid
          // leaving a product without a price on the connected account.
          try {
            await withStripeCircuit(() =>
              stripe.products.update(
                product.id,
                { active: false },
                { stripeAccount: stripeAccountId, idempotencyKey: `archive-${product.id}` }
              )
            );
          } catch {
            // Best-effort cleanup; log but don't mask the original error.
            req.log.warn(
              { productId: product.id, stripeAccountId },
              "Failed to archive orphaned product after price creation failure"
            );
          }
          throw priceErr;
        }

        await withStripeCircuit(() =>
          stripe.products.update(
            product.id,
            { default_price: price.id },
            { stripeAccount: stripeAccountId, idempotencyKey: updateIdempotencyKey }
          )
        );
      } catch (err) {
        if (mapStripeError(err, res, { circuitOpen: CIRCUIT_OPEN_ERROR })) return;
        throw err;
      }

      return res.status(201).send(formatProduct(product, price));
    }
  );
};

export default productRoutes;
