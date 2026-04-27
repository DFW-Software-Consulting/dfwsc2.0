import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clients } from "../db/schema";
import type { Workspace } from "./validation";

type StripeSubLike = Pick<Stripe.Subscription, "id" | "metadata" | "customer">;
type StripeScheduleLike = Pick<Stripe.SubscriptionSchedule, "id" | "metadata" | "customer">;

export type ResolvedStripeClient = {
  clientId: string;
  clientName: string;
  clientEmail: string;
  matchedBy: "metadata";
};

export type MetadataBackfill = {
  kind: "subscription" | "schedule";
  id: string;
  clientId: string;
  existingMetadata: Record<string, string>;
};

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

  let scopedClients: Array<typeof clients.$inferSelect> = [];

  if (metadataClientIds.length > 0) {
    const clientRows = await db
      .select()
      .from(clients)
      .where(and(eq(clients.workspace, workspace), inArray(clients.id, metadataClientIds)));

    scopedClients = clientRows;
  }

  const byId = new Map(scopedClients.map((c) => [c.id, c]));

  const backfills: MetadataBackfill[] = [];

  const resolveSingle = (
    obj: StripeSubLike | StripeScheduleLike,
    kind: "subscription" | "schedule"
  ): ResolvedStripeClient | null => {
    const metadataClientId = obj.metadata?.clientId?.trim();

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