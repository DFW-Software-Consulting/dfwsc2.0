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

export type CalendarInterval = "week" | "bi_weekly" | "month" | "quarter" | "year";

/**
 * Convert calendar interval to Stripe interval format.
 * Supports: week, bi_weekly, month, quarter, year
 */
export function toStripeInterval(interval: CalendarInterval): {
  interval: "week" | "month" | "year";
  interval_count: number;
} {
  switch (interval) {
    case "week":
      return { interval: "week", interval_count: 1 };
    case "bi_weekly":
      return { interval: "week", interval_count: 2 };
    case "month":
      return { interval: "month", interval_count: 1 };
    case "quarter":
      return { interval: "month", interval_count: 3 };
    case "year":
      return { interval: "year", interval_count: 1 };
    default:
      // Fallback for any unexpected values
      return { interval: "month", interval_count: 1 };
  }
}

/**
 * Calculate the number of billing iterations between two dates.
 * Returns the ceiling of iterations (partial periods count as full periods).
 */
export function calculateIterations(
  startDate: string,
  endDate: string,
  interval: CalendarInterval
): number {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (end <= start) {
    return 0;
  }

  switch (interval) {
    case "week": {
      const diffTime = end.getTime() - start.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return Math.ceil(diffDays / 7);
    }
    case "bi_weekly": {
      const diffTime = end.getTime() - start.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return Math.ceil(diffDays / 14);
    }
    case "month": {
      const yearDiff = end.getUTCFullYear() - start.getUTCFullYear();
      const monthDiff = end.getUTCMonth() - start.getUTCMonth();
      const dayDiff = end.getUTCDate() - start.getUTCDate();
      // If end day is before start day, we haven't completed the full month
      const totalMonths = yearDiff * 12 + monthDiff + (dayDiff >= 0 ? 0 : -1);
      return Math.max(1, totalMonths + 1); // Include the starting month
    }
    case "quarter": {
      const yearDiff = end.getUTCFullYear() - start.getUTCFullYear();
      const monthDiff = end.getUTCMonth() - start.getUTCMonth();
      const dayDiff = end.getUTCDate() - start.getUTCDate();
      const totalMonths = yearDiff * 12 + monthDiff + (dayDiff >= 0 ? 0 : -1);
      return Math.max(1, Math.ceil((totalMonths + 1) / 3));
    }
    case "year": {
      const yearDiff = end.getUTCFullYear() - start.getUTCFullYear();
      const monthDiff = end.getUTCMonth() - start.getUTCMonth();
      const dayDiff = end.getUTCDate() - start.getUTCDate();
      // If end is before the anniversary date, subtract a year
      const totalYears = yearDiff + (monthDiff > 0 || (monthDiff === 0 && dayDiff >= 0) ? 0 : -1);
      return Math.max(1, totalYears + 1); // Include the starting year
    }
    default:
      return 0;
  }
}

/**
 * Calculate the next payment date based on start date and interval.
 */
export function calculateNextPaymentDate(
  startDate: string,
  interval: CalendarInterval,
  paymentsMade: number
): Date {
  const start = new Date(startDate);

  switch (interval) {
    case "week":
      return new Date(start.getTime() + paymentsMade * 7 * 24 * 60 * 60 * 1000);
    case "bi_weekly":
      return new Date(start.getTime() + paymentsMade * 14 * 24 * 60 * 60 * 1000);
    case "month": {
      const next = new Date(start);
      next.setUTCMonth(next.getUTCMonth() + paymentsMade);
      return next;
    }
    case "quarter": {
      const next = new Date(start);
      next.setUTCMonth(next.getUTCMonth() + paymentsMade * 3);
      return next;
    }
    case "year": {
      const next = new Date(start);
      next.setUTCFullYear(next.getUTCFullYear() + paymentsMade);
      return next;
    }
    default:
      return start;
  }
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
