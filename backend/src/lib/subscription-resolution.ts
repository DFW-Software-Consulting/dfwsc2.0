import { and, eq, inArray, or } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clients } from "../db/schema";
import type { Workspace } from "./validation";

export type StripeCustomerRef = string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined;

type StripeSubLike = Pick<Stripe.Subscription, "id" | "metadata" | "customer">;
type StripeScheduleLike = Pick<Stripe.SubscriptionSchedule, "id" | "metadata" | "customer">;

export type ResolvedStripeClient = {
  clientId: string;
  clientName: string;
  clientEmail: string;
  matchedBy: "metadata" | "stripe_customer";
};

export type MetadataBackfill = {
  kind: "subscription" | "schedule";
  id: string;
  clientId: string;
  existingMetadata: Record<string, string>;
};

export function getStripeCustomerId(customer: StripeCustomerRef): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

export async function resolveSubscriptionClients({
  subscriptions,
  schedules,
  workspace,
}: {
  subscriptions: StripeSubLike[];
  schedules: StripeScheduleLike[];
  workspace: Workspace;
}): Promise<{
  subscriptionMap: Map<string, ResolvedStripeClient>;
  scheduleMap: Map<string, ResolvedStripeClient>;
  backfills: MetadataBackfill[];
}> {
  const allObjects = [...subscriptions, ...schedules];

  const metadataClientIds = [
    ...new Set(allObjects.map((obj) => obj.metadata?.clientId).filter(Boolean) as string[]),
  ];

  const stripeCustomerIds = [
    ...new Set(
      allObjects.map((obj) => getStripeCustomerId(obj.customer)).filter(Boolean) as string[]
    ),
  ];

  let scopedClients: Array<typeof clients.$inferSelect> = [];

  if (metadataClientIds.length > 0 || stripeCustomerIds.length > 0) {
    let clientRows: Array<typeof clients.$inferSelect> = [];
    if (metadataClientIds.length > 0 && stripeCustomerIds.length > 0) {
      clientRows = await db
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.workspace, workspace),
            or(
              inArray(clients.id, metadataClientIds),
              inArray(clients.stripeCustomerId, stripeCustomerIds)
            )
          )
        );
    } else if (metadataClientIds.length > 0) {
      clientRows = await db
        .select()
        .from(clients)
        .where(and(eq(clients.workspace, workspace), inArray(clients.id, metadataClientIds)));
    } else if (stripeCustomerIds.length > 0) {
      clientRows = await db
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.workspace, workspace),
            inArray(clients.stripeCustomerId, stripeCustomerIds)
          )
        );
    }

    scopedClients = clientRows;
  }

  const byId = new Map(scopedClients.map((c) => [c.id, c]));
  const byStripeCustomer = new Map(
    scopedClients.filter((c) => !!c.stripeCustomerId).map((c) => [c.stripeCustomerId as string, c])
  );

  const backfills: MetadataBackfill[] = [];

  const resolveSingle = (
    obj: StripeSubLike | StripeScheduleLike,
    kind: "subscription" | "schedule"
  ): ResolvedStripeClient | null => {
    const metadataClientId = obj.metadata?.clientId?.trim();
    const customerId = getStripeCustomerId(obj.customer);

    if (metadataClientId && byId.has(metadataClientId)) {
      const client = byId.get(metadataClientId);
      if (!client) return null;
      return {
        clientId: client.id,
        clientName: client.name,
        clientEmail: client.email,
        matchedBy: "metadata",
      };
    }

    if (customerId && byStripeCustomer.has(customerId)) {
      const client = byStripeCustomer.get(customerId);
      if (!client) return null;
      backfills.push({
        kind,
        id: obj.id,
        clientId: client.id,
        existingMetadata: obj.metadata ?? {},
      });
      return {
        clientId: client.id,
        clientName: client.name,
        clientEmail: client.email,
        matchedBy: "stripe_customer",
      };
    }

    return null;
  };

  const subscriptionMap = new Map<string, ResolvedStripeClient>();
  const scheduleMap = new Map<string, ResolvedStripeClient>();

  for (const sub of subscriptions) {
    const resolved = resolveSingle(sub, "subscription");
    if (resolved) subscriptionMap.set(sub.id, resolved);
  }

  for (const sch of schedules) {
    const resolved = resolveSingle(sch, "schedule");
    if (resolved) scheduleMap.set(sch.id, resolved);
  }

  return { subscriptionMap, scheduleMap, backfills };
}
