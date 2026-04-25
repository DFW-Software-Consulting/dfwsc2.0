import "dotenv/config";
import type Stripe from "stripe";
import { db } from "../src/db/client";
import { clientGroups, clients, onboardingTokens, webhookEvents } from "../src/db/schema";
import { stripe } from "../src/lib/stripe";

type ResetSummary = {
  db: {
    onboardingTokensDeleted: number;
    webhookEventsDeleted: number;
    clientsDeleted: number;
    groupsDeleted: number;
    adminsPreserved: number;
  };
  stripe: {
    subscriptionsCanceled: number;
    schedulesCanceled: number;
    customersDeleted: number;
  };
};

function printHelp(): void {
  console.log(`\nReset local DB + Stripe test data (admin preserved)\n\nUsage:\n  npm run reset:test-data -- [options]\n\nOptions:\n  --dry-run      Show what would happen without mutating data\n  --skip-db      Skip local DB reset\n  --skip-stripe  Skip Stripe test-mode cleanup\n  --help         Show this help\n`);
}

async function countAdmins(): Promise<number> {
  const rows = await db.execute<{ count: string }>(`SELECT COUNT(*)::text as count FROM admins`);
  return Number(rows.rows[0]?.count ?? "0");
}

async function resetDb(dryRun: boolean): Promise<ResetSummary["db"]> {
  const [onboardingRows, webhookRows, clientRows, groupRows] = await Promise.all([
    db.select({ id: onboardingTokens.id }).from(onboardingTokens),
    db.select({ id: webhookEvents.id }).from(webhookEvents),
    db.select({ id: clients.id }).from(clients),
    db.select({ id: clientGroups.id }).from(clientGroups),
  ]);

  const adminsPreserved = await countAdmins();

  if (!dryRun) {
    await db.transaction(async (tx) => {
      await tx.delete(onboardingTokens);
      await tx.delete(webhookEvents);
      await tx.delete(clients);
      await tx.delete(clientGroups);
    });
  }

  return {
    onboardingTokensDeleted: onboardingRows.length,
    webhookEventsDeleted: webhookRows.length,
    clientsDeleted: clientRows.length,
    groupsDeleted: groupRows.length,
    adminsPreserved,
  };
}

async function listAllSubscriptions(): Promise<Stripe.Subscription[]> {
  const out: Stripe.Subscription[] = [];
  for await (const sub of stripe.subscriptions.list({ status: "all", limit: 100 })) {
    out.push(sub);
  }
  return out;
}

async function listAllSchedules(): Promise<Stripe.SubscriptionSchedule[]> {
  const out: Stripe.SubscriptionSchedule[] = [];
  for await (const schedule of stripe.subscriptionSchedules.list({ limit: 100 })) {
    out.push(schedule);
  }
  return out;
}

async function listAllCustomers(): Promise<Stripe.Customer[]> {
  const out: Stripe.Customer[] = [];
  for await (const customer of stripe.customers.list({ limit: 100 })) {
    if (!customer.deleted) out.push(customer);
  }
  return out;
}

async function resetStripe(dryRun: boolean): Promise<ResetSummary["stripe"]> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    throw new Error("STRIPE_SECRET_KEY is required.");
  }
  if (!stripeKey.startsWith("sk_test_")) {
    throw new Error("Refusing to run Stripe reset with a non-test key.");
  }

  const [subscriptions, schedules, customers] = await Promise.all([
    listAllSubscriptions(),
    listAllSchedules(),
    listAllCustomers(),
  ]);

  const cancellableSubs = subscriptions.filter(
    (sub) => sub.status !== "canceled" && sub.status !== "incomplete_expired"
  );
  const cancellableSchedules = schedules.filter(
    (schedule) =>
      schedule.status !== "canceled" &&
      schedule.status !== "released" &&
      schedule.status !== "completed"
  );

  if (!dryRun) {
    for (const sub of cancellableSubs) {
      await stripe.subscriptions.cancel(sub.id);
    }
    for (const schedule of cancellableSchedules) {
      await stripe.subscriptionSchedules.cancel(schedule.id);
    }
    for (const customer of customers) {
      await stripe.customers.del(customer.id);
    }
  }

  return {
    subscriptionsCanceled: cancellableSubs.length,
    schedulesCanceled: cancellableSchedules.length,
    customersDeleted: customers.length,
  };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    printHelp();
    return;
  }

  const dryRun = args.has("--dry-run");
  const skipDb = args.has("--skip-db");
  const skipStripe = args.has("--skip-stripe");

  console.log("Starting test-data reset...");
  if (dryRun) console.log("DRY RUN mode enabled. No data will be mutated.");

  const summary: ResetSummary = {
    db: {
      onboardingTokensDeleted: 0,
      webhookEventsDeleted: 0,
      clientsDeleted: 0,
      groupsDeleted: 0,
      adminsPreserved: 0,
    },
    stripe: {
      subscriptionsCanceled: 0,
      schedulesCanceled: 0,
      customersDeleted: 0,
    },
  };

  if (!skipDb) {
    summary.db = await resetDb(dryRun);
  }

  if (!skipStripe) {
    summary.stripe = await resetStripe(dryRun);
  }

  console.log("\nReset complete.");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("Reset failed:", error);
  process.exit(1);
});
