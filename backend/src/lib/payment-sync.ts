import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { stripe } from "./stripe";

type PaymentStatus = "active" | "past_due" | "canceled" | "unpaid" | "trialing" | "none";

async function listAllSubscriptions(
  params: Stripe.SubscriptionListParams
): Promise<Stripe.Subscription[]> {
  const all: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;

  while (true) {
    const page = await stripe.subscriptions.list({
      ...params,
      limit: 100,
      starting_after: startingAfter,
    });
    all.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) break;
  }

  return all;
}

function effectiveStatus(subs: Stripe.Subscription[]): PaymentStatus {
  if (subs.length === 0) return "none";
  const statuses = subs.map((s) => s.status);
  for (const preferred of ["active", "trialing", "past_due", "unpaid", "canceled"] as const) {
    if (statuses.includes(preferred)) return preferred;
  }
  return "none";
}

export async function runPaymentSync(): Promise<number> {
  const syncableClients = await db
    .select({ id: clients.id, stripeCustomerId: clients.stripeCustomerId })
    .from(clients)
    .where(
      and(
        inArray(clients.workspace, ["dfwsc_services"]),
        isNotNull(clients.stripeCustomerId)
      )
    );

  if (syncableClients.length === 0) return 0;

  const allSubs = await listAllSubscriptions({ status: "all" });

  const subsByCustomer = new Map<string, Stripe.Subscription[]>();
  for (const sub of allSubs) {
    const custId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    if (!custId) continue;
    const existing = subsByCustomer.get(custId) ?? [];
    existing.push(sub);
    subsByCustomer.set(custId, existing);
  }

  const now = new Date();
  let synced = 0;

  for (let i = 0; i < syncableClients.length; i += 50) {
    const batch = syncableClients.slice(i, i + 50);
    await Promise.all(
      batch.map((client) => {
        const customerId = client.stripeCustomerId;
        if (!customerId) {
          return Promise.resolve();
        }
        const subs = subsByCustomer.get(customerId) ?? [];
        const status = effectiveStatus(subs);
        return db
          .update(clients)
          .set({ paymentStatus: status, paymentStatusSyncedAt: now, updatedAt: now })
          .where(eq(clients.id, client.id));
      })
    );
    synced += batch.length;
  }

  return synced;
}

export function startPaymentSyncJob(): void {
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  runPaymentSync().catch((err) => console.error("[payment-sync] Initial sync failed:", err));

  setInterval(() => {
    runPaymentSync().catch((err) => console.error("[payment-sync] Periodic sync failed:", err));
  }, FIFTEEN_MINUTES).unref();
}
