import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { z } from "zod";
import { requireAdminJwt } from "../lib/auth";
import { isCircuitOpenError, withStripeCircuit } from "../lib/circuit-breakers";
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../lib/constants";
import { adminRateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { parseBody } from "../lib/validation";

interface CreateProductBody {
  name: string;
  description?: string;
  amountCents: number;
  currency?: string;
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

const createProductBodySchema = z.object({
  name: z.string({ error: "name is required." }).trim().min(1, "name is required."),
  description: z.string().optional(),
  amountCents: z
    .number({ error: "amountCents must be a positive integer." })
    .int("amountCents must be a positive integer.")
    .positive("amountCents must be a positive integer."),
  currency: z.string().optional(),
});

const productRoutes: FastifyPluginAsync = async (app) => {
  // GET /tax-rates — list active Stripe tax rates (platform account)
  app.get(
    "/tax-rates",
    { preHandler: [requireAdminJwt, adminCrudRateLimit] },
    async (_req, res) => {
      let taxRates: Stripe.TaxRate[];
      try {
        ({ data: taxRates } = await withStripeCircuit(() =>
          stripe.taxRates.list({
            active: true,
            limit: 100,
          })
        ));
      } catch (err) {
        if (isCircuitOpenError(err)) {
          return res.status(503).send({ error: "Stripe service temporarily unavailable." });
        }
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
    }
  );

  // GET /products — list active Stripe products (platform account)
  app.get("/products", { preHandler: [requireAdminJwt, adminCrudRateLimit] }, async (_req, res) => {
    let products: Stripe.Product[];
    try {
      ({ data: products } = await withStripeCircuit(() =>
        stripe.products.list({
          active: true,
          limit: 100,
          expand: ["data.default_price"],
        })
      ));
    } catch (err) {
      if (isCircuitOpenError(err)) {
        return res.status(503).send({ error: "Stripe service temporarily unavailable." });
      }
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

  // POST /products — create Stripe product + price (platform account)
  app.post<{ Body: CreateProductBody }>(
    "/products",
    { preHandler: [requireAdminJwt, adminCrudRateLimit] },
    async (req, res) => {
      const body = parseBody(createProductBodySchema, req.body, res) as CreateProductBody | null;
      if (!body) return;
      const { name, description, amountCents, currency = "usd" } = body;

      let product: Stripe.Product;
      let price: Stripe.Price;
      try {
        product = await withStripeCircuit(() =>
          stripe.products.create({
            name: name.trim(),
            ...(description?.trim() ? { description: description.trim() } : {}),
          })
        );

        price = await withStripeCircuit(() =>
          stripe.prices.create({
            product: product.id,
            unit_amount: amountCents,
            currency,
          })
        );

        await withStripeCircuit(() =>
          stripe.products.update(product.id, { default_price: price.id })
        );
      } catch (err) {
        if (isCircuitOpenError(err)) {
          return res.status(503).send({ error: "Stripe service temporarily unavailable." });
        }
        throw err;
      }

      return res.status(201).send(formatProduct(product, price));
    }
  );
};

export default productRoutes;
