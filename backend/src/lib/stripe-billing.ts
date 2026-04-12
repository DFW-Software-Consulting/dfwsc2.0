import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { type clientGroups, clients, settings } from "../db/schema";
import { stripe } from "./stripe";

export { stripe };

export async function getSettings(): Promise<Record<string, string>> {
  const allSettings = await db.select().from(settings);
  return allSettings.reduce(
    (acc, s) => {
      acc[s.key] = s.value;
      return acc;
    },
    {} as Record<string, string>
  );
}

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

function validateFeePercent(value: string, source: string): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${source} processingFeePercent: must be a valid number.`);
  }
  if (parsed < 0 || parsed > 100) {
    throw new Error(`${source} processingFeePercent must be between 0 and 100.`);
  }
  return parsed;
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
    const validatedPercent = validateFeePercent(client.processingFeePercent, "client");
    return Math.round((amount * validatedPercent) / 100);
  }
  if (client.processingFeeCents !== null && client.processingFeeCents !== undefined) {
    return client.processingFeeCents;
  }
  if (group?.processingFeePercent !== null && group?.processingFeePercent !== undefined) {
    if (typeof amount !== "number") {
      throw new Error("amount is required when group uses a percentage-based fee.");
    }
    const validatedPercent = validateFeePercent(group.processingFeePercent, "group");
    return Math.round((amount * validatedPercent) / 100);
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
    const validatedPercent = validateFeePercent(dbPercent, "default");
    return Math.round((amount * validatedPercent) / 100);
  }

  const dbCents = dbDefaultsMap.get("default_fee_cents");
  if (dbCents) {
    return parseInt(dbCents, 10);
  }

  return Number(process.env.DEFAULT_PROCESS_FEE_CENTS ?? 0);
}
