import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { type clientGroups, clients, settings } from "../db/schema";
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

export async function resolveClientFee(
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
