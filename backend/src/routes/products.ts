import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { requireAdminJwt } from "../lib/auth";
import { stripe } from "../lib/stripe";

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

const productRoutes: FastifyPluginAsync = async (app) => {
  // GET /tax-rates — list active Stripe tax rates (platform account)
  app.get("/tax-rates", { preHandler: requireAdminJwt }, async (_req, res) => {
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
  });

  // GET /products — list active Stripe products (platform account)
  app.get("/products", { preHandler: requireAdminJwt }, async (_req, res) => {
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
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { name, description, amountCents, currency = "usd" } = req.body;

      if (!name?.trim()) {
        return res.status(400).send({ error: "name is required." });
      }
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return res.status(400).send({ error: "amountCents must be a positive integer." });
      }

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
