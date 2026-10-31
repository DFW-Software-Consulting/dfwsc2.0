import "dotenv/config";
import { readFileSync } from "node:fs";
import { and, asc, eq, isNotNull, notExists } from "drizzle-orm";
import { db } from "../src/db/client";
import { billingCustomers, clientOnboardingSubmissions } from "../src/db/schema";
import {
  BillingCustomerStripeError,
  ensureBillingCustomer,
  findExistingBillingCustomer,
} from "../src/lib/billing-customer";

// Links already-onboarded clients (e.g. CP-004) to a DFWSC billing Stripe Customer.
// Dry run by default: only reads the database and lists Stripe Customers (read-only).
// Form answers are not stored, so the email comes from a CSV: "client_code,email". Put the
// billing email there (the "Billing email" answer, else the contact email).
// Uses whichever DATABASE_URL / STRIPE_SECRET_KEY are in the environment: check them first.

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function printHelp(): void {
  out(
    "\nBackfill billing Customers\n\nUsage:\n  npx tsx scripts/backfill-billing-customers.ts --csv emails.csv [--apply]\n\nOptions:\n  --csv <file>  Required. Lines of client_code,email (header optional)\n  --apply       Create/link for real. Without it nothing is written anywhere\n  --help        Show this help\n"
  );
}

function parseCsv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const [code, email] = raw.split(",").map((v) => v.trim());
    if (!code || !email || code.toLowerCase() === "client_code") continue;
    out.set(code.toUpperCase(), email);
  }
  return out;
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
  const emails = parseCsv(readFileSync(csvPath, "utf8"));

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

  const tally = { exists: 0, matched: 0, created: 0, ambiguous: 0, skipped: 0, failed: 0 };
  out(apply ? "APPLY mode" : "DRY RUN (nothing is written; pass --apply)");
  for (const row of rows) {
    const code = row.projectCode as string;
    const email = emails.get(code);
    if (!email) {
      tally.skipped++;
      out(`${code}: skipped (no email in the CSV)`);
      continue;
    }
    const company = row.company ?? code;
    try {
      if (!apply) {
        const found = await findExistingBillingCustomer({ clientCode: code, email });
        if (found.kind === "ambiguous") tally.ambiguous++;
        else if (found.kind === "none") tally.created++;
        else tally.matched++;
        out(
          `${code}: would ${found.kind === "none" ? "create a Customer" : found.kind === "ambiguous" ? "flag as ambiguous" : `link ${found.stripeCustomerId}`}`
        );
        continue;
      }
      const result = await ensureBillingCustomer({
        clientCode: code,
        company,
        email,
        linkSource: "backfill",
      });
      if (result.status === "ambiguous") tally.ambiguous++;
      else if (result.source === "created") tally.created++;
      else tally.matched++;
      out(
        `${code}: ${result.status === "ambiguous" ? "ambiguous (several Customers share the email)" : `${result.source} ${result.stripeCustomerId}`}`
      );
    } catch (error) {
      tally.failed++;
      const detail = error instanceof BillingCustomerStripeError ? error.code : "error";
      out(`${code}: failed (${detail})`);
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
