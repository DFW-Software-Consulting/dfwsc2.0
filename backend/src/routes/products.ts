import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { z } from "zod";
import { requireAdminJwt } from "../lib/auth";
import { errors } from "../lib/errors";
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
  max: 120,
  windowMs: 60_000,
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
      const { data: taxRates } = await stripe.taxRates.list({
        active: true,
        limit: 100,
      });

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
    const { data: products } = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ["data.default_price"],
    });

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

      const product = await stripe.products.create({
        name: name.trim(),
        ...(description?.trim() ? { description: description.trim() } : {}),
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: amountCents,
        currency,
      });

      await stripe.products.update(product.id, { default_price: price.id });

      return res.status(201).send(formatProduct(product, price));
    }
  );
};

export default productRoutes;
