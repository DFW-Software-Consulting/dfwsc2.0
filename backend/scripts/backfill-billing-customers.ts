import "dotenv/config";
import { readFileSync } from "node:fs";
import { and, asc, eq, isNotNull, notExists } from "drizzle-orm";
import { db } from "../src/db/client";
import { billingCustomers, clientOnboardingSubmissions } from "../src/db/schema";
import {
  BillingCustomerStripeError,
  ensureBillingCustomer,
  findExistingBillingCustomer,
  isValidEmail,
  linkPinnedBillingCustomer,
} from "../src/lib/billing-customer";
import { stripe } from "../src/lib/stripe";

// Links already-onboarded clients (e.g. CP-004) to a DFWSC billing Stripe Customer, and
// resolves submissions flagged "ambiguous" by pinning a Customer id.
// Dry run by default: only reads the database and Stripe (list/retrieve).
// Form answers are not stored, so the data comes from a CSV (no quoting, no commas inside
// values): client_code,email[,company][,stripe_customer_id]
//   - email: the billing email (the "Billing email" answer, else the contact email).
//   - company: overrides the folder-derived name used when a Customer is created.
//   - stripe_customer_id: link exactly this Customer (it must exist and not be deleted).
// Uses whichever DATABASE_URL / STRIPE_SECRET_KEY are in the environment; it prints them first.

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function printHelp(): void {
  out(
    "\nBackfill billing Customers\n\nUsage:\n  npx tsx scripts/backfill-billing-customers.ts --csv emails.csv [--apply]\n\nCSV columns: client_code,email[,company][,stripe_customer_id]\n\nOptions:\n  --csv <file>  Required.\n  --apply       Create/link for real. Without it nothing is written anywhere\n  --help        Show this help\n"
  );
}

interface CsvEntry {
  email: string;
  company?: string;
  stripeCustomerId?: string;
}

function parseCsv(text: string): Map<string, CsvEntry> {
  const entries = new Map<string, CsvEntry>();
  for (const raw of text.split(/\r?\n/)) {
    const [code, email, company, customerId] = raw.split(",").map((v) => v.trim());
    if (!code || !email || code.toLowerCase() === "client_code") continue;
    entries.set(code.toUpperCase(), {
      email,
      ...(company ? { company } : {}),
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    });
  }
  return entries;
}

function stripeMode(key: string | undefined): string {
  if (!key) return "unknown (no key)";
  const kind = key.startsWith("rk_") ? "restricted" : key.startsWith("sk_") ? "secret" : "unknown";
  const mode = key.includes("_live_") ? "LIVE" : key.includes("_test_") ? "test" : "unknown";
  return `${mode} (${kind} key)`;
}

function databaseTarget(url: string | undefined): string {
  try {
    const parsed = new URL(url ?? "");
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return "unknown";
  }
}

async function preflight(): Promise<void> {
  out(`Stripe mode: ${stripeMode(process.env.STRIPE_SECRET_KEY)}`);
  try {
    const account = await stripe.accounts.retrieve();
    out(`Stripe platform account: ${account.id}`);
  } catch {
    out("Stripe platform account: could not be read (check the key)");
  }
  out(`Database: ${databaseTarget(process.env.DATABASE_URL)}`);
  out(
    `CLIENT_ONBOARDING_BILLING_CUSTOMER: ${process.env.CLIENT_ONBOARDING_BILLING_CUSTOMER?.trim() === "true" ? "on" : "off"}`
  );
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    printHelp();
    return 0;
  }
  const apply = args.includes("--apply");
  const csvIndex = args.indexOf("--csv");
  const csvPath = csvIndex >= 0 ? args[csvIndex + 1] : undefined;
  if (!csvPath) {
    printHelp();
    return 1;
  }
  const entries = parseCsv(readFileSync(csvPath, "utf8"));

  await preflight();
  out(apply ? "APPLY mode" : "DRY RUN (nothing is written; pass --apply)");

  const rows = await db
    .select({
      projectCode: clientOnboardingSubmissions.projectCode,
      company: clientOnboardingSubmissions.folderName,
    })
    .from(clientOnboardingSubmissions)
    .where(
      and(
        eq(clientOnboardingSubmissions.status, "completed"),
        isNotNull(clientOnboardingSubmissions.projectCode),
        notExists(
          db
            .select({ one: billingCustomers.clientCode })
            .from(billingCustomers)
            .where(eq(billingCustomers.clientCode, clientOnboardingSubmissions.projectCode))
        )
      )
    )
    .orderBy(asc(clientOnboardingSubmissions.projectNumber));

  const tally = { linked: 0, created: 0, ambiguous: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    const code = row.projectCode as string;
    const entry = entries.get(code);
    if (!entry) {
      tally.skipped++;
      out(`${code}: skipped (not in the CSV)`);
      continue;
    }
    if (!isValidEmail(entry.email)) {
      tally.skipped++;
      out(`${code}: skipped (the CSV email is not a valid address)`);
      continue;
    }
    const input = {
      clientCode: code,
      company: entry.company ?? row.company ?? code,
      email: entry.email,
      linkSource: "backfill" as const,
    };
    try {
      if (!apply) {
        if (entry.stripeCustomerId) {
          const found = await stripe.customers.retrieve(entry.stripeCustomerId);
          if (found.deleted) throw new BillingCustomerStripeError("stripe.customer:deleted", false);
          tally.linked++;
          out(`${code}: would link ${entry.stripeCustomerId}`);
          continue;
        }
        const found = await findExistingBillingCustomer(input);
        if (found.kind === "ambiguous") {
          tally.ambiguous++;
          out(`${code}: would flag as ambiguous (add stripe_customer_id to the CSV to pin one)`);
        } else if (found.kind === "none") {
          tally.created++;
          out(`${code}: would create a Customer`);
        } else {
          tally.linked++;
          out(`${code}: would link ${found.stripeCustomerId}`);
        }
        continue;
      }
      const result = entry.stripeCustomerId
        ? await linkPinnedBillingCustomer(input, entry.stripeCustomerId)
        : await ensureBillingCustomer(input);
      if (result.status !== "linked") {
        tally.ambiguous++;
        out(
          `${code}: ${result.status} (several Customers share the email; add stripe_customer_id to the CSV)`
        );
        continue;
      }
      await db
        .update(clientOnboardingSubmissions)
        .set({ billingStatus: "linked", billingCustomerId: result.stripeCustomerId })
        .where(eq(clientOnboardingSubmissions.projectCode, code));
      if (result.source === "created") tally.created++;
      else tally.linked++;
      out(`${code}: ${result.source} ${result.stripeCustomerId}`);
    } catch (error) {
      tally.failed++;
      out(
        `${code}: failed (${error instanceof BillingCustomerStripeError ? error.code : "error"})`
      );
    }
  }
  out(JSON.stringify(tally));
  return tally.failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
