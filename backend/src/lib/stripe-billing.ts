import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { stripe } from "./stripe";

export async function ensureStripeCustomer(client: {
  id: string;
  email: string;
  name: string;
  stripeCustomerId: string | null;
}): Promise<string> {
  if (client.stripeCustomerId) {
    return client.stripeCustomerId;
  }

  const cust = await stripe.customers.create(
    { email: client.email, name: client.name, metadata: { clientId: client.id } },
    { idempotencyKey: `customer-${client.id}` }
  );

  await db.update(clients).set({ stripeCustomerId: cust.id }).where(eq(clients.id, client.id));

  return cust.id;
}

export function toStripeInterval(interval: "monthly" | "quarterly" | "yearly"): {
  interval: "month" | "year";
  interval_count: number;
} {
  if (interval === "monthly") return { interval: "month", interval_count: 1 };
  if (interval === "quarterly") return { interval: "month", interval_count: 3 };
  return { interval: "year", interval_count: 1 };
}
