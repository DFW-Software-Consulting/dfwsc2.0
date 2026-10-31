import "dotenv/config";
import { readFileSync } from "node:fs";
import { and, asc, eq, isNotNull, notExists } from "drizzle-orm";
import Stripe from "stripe";

// Links already-onboarded clients (e.g. CP-004) to a DFWSC billing Stripe Customer, and
// resolves submissions flagged "ambiguous" by pinning a Customer id.
// Dry run by default: only reads the database and Stripe (list/retrieve).
// Form answers are not stored, so the data comes from a CSV (no quoting, no commas inside
// values): client_code,email[,company][,stripe_customer_id]
//   - email: the billing email (the "Billing email" answer, else the contact email).
//   - company: overrides the folder-derived name used when a Customer is created.
//   - stripe_customer_id: link exactly this Customer (it must exist and not be deleted).
// Uses whichever DATABASE_URL / STRIPE_SECRET_KEY are in the environment; it prints them first.
//
// It lives in src/ so the build ships it in the API image (dist/scripts/ in the container).
// The db and Stripe modules are loaded only after the arguments are checked: lib/stripe.ts
// throws at import without STRIPE_SECRET_KEY, and --help must work without any env.

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export function helpText(): string {
  return `
Backfill billing Customers

Usage:
  node dist/scripts/backfill-billing-customers.js --csv <file|-> [--apply]    (API container)
  npx tsx src/scripts/backfill-billing-customers.ts --csv <file|-> [--apply]  (local, in backend/)

CSV columns: client_code,email[,company][,stripe_customer_id]

Options:
  --csv <file>  Required. Use "-" to read the CSV from stdin, e.g.
                docker exec -i <api container> node dist/scripts/backfill-billing-customers.js --csv - < file.csv
  --apply       Create/link for real. Without it nothing is written anywhere
  --help        Show this help
`;
}

export interface CsvEntry {
  email: string;
  company?: string;
  stripeCustomerId?: string;
}

export function parseCsv(text: string): Map<string, CsvEntry> {
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

function reasonForStatus(status: number | string | undefined): string {
  if (status === "deleted") return "the pinned Customer is deleted in Stripe";
  if (status === 404) {
    return "the pinned Customer does not exist in Stripe (check the id and the Stripe mode)";
  }
  if (status === 401 || status === 403) {
    return "Stripe refused the key (authentication or permission)";
  }
  if (typeof status === "number" && (status >= 500 || status === 429)) {
    return "Stripe was unreachable or busy (network, rate limit or outage); try again";
  }
  return `Stripe error ${status ?? "unknown"}`;
}

/** A short, PII-free reason for a failed Customer lookup or link. */
export function describeFailure(error: unknown): string {
  if (error instanceof Stripe.errors.StripeError) {
    if (error.code === "resource_missing") return reasonForStatus(404);
    if (
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeRateLimitError ||
      error instanceof Stripe.errors.StripeAPIError
    ) {
      return reasonForStatus(503);
    }
    return reasonForStatus(error.statusCode ?? error.type);
  }
  // BillingCustomerStripeError (from linkPinnedBillingCustomer): code "stripe.customer:<status>".
  if (error instanceof Error && error.name === "BillingCustomerStripeError") {
    const suffix = error.message.split(":").pop() ?? "";
    return reasonForStatus(/^\d+$/.test(suffix) ? Number(suffix) : suffix);
  }
  return "unexpected error";
}

export interface RunOptions {
  /** Reads the CSV from stdin when --csv is "-". */
  readStdin?: () => string;
}

export async function run(args: string[], options: RunOptions = {}): Promise<number> {
  if (args.includes("--help")) {
    out(helpText());
    return 0;
  }
  const apply = args.includes("--apply");
  const csvIndex = args.indexOf("--csv");
  const csvPath = csvIndex >= 0 ? args[csvIndex + 1] : undefined;
  if (!csvPath) {
    out(helpText());
    return 1;
  }
  const readStdin = options.readStdin ?? (() => readFileSync(0, "utf8"));
  const entries = parseCsv(csvPath === "-" ? readStdin() : readFileSync(csvPath, "utf8"));

  const [{ db }, { billingCustomers, clientOnboardingSubmissions }, billing, { stripe }] =
    await Promise.all([
      import("../db/client"),
      import("../db/schema"),
      import("../lib/billing-customer"),
      import("../lib/stripe"),
    ]);

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

  const tally = { linked: 0, created: 0, ambiguous: 0, invalidEmail: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    const code = row.projectCode as string;
    const entry = entries.get(code);
    if (!entry) {
      tally.skipped++;
      out(`${code}: skipped (not in the CSV)`);
      continue;
    }
    if (!billing.isValidEmail(entry.email)) {
      tally.skipped++;
      out(`${code}: skipped (the CSV email is not a valid address)`);
      continue;
    }
    const company = entry.company ?? row.company ?? code;
    if (!entry.company) {
      out(
        `${code}: note: no company in the CSV, using ${row.company ? "the folder name" : "the client code"} "${company}"`
      );
    }
    const input = {
      clientCode: code,
      company,
      email: entry.email,
      linkSource: "backfill" as const,
    };
    try {
      if (!apply) {
        if (entry.stripeCustomerId) {
          const found = await stripe.customers.retrieve(entry.stripeCustomerId);
          if (found.deleted) {
            tally.failed++;
            out(`${code}: failed (${reasonForStatus("deleted")})`);
            continue;
          }
          tally.linked++;
          out(`${code}: would link ${entry.stripeCustomerId}`);
          continue;
        }
        const found = await billing.findExistingBillingCustomer(input);
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
        ? await billing.linkPinnedBillingCustomer(input, entry.stripeCustomerId)
        : await billing.ensureBillingCustomer(input);
      if (result.status === "invalid_email") {
        tally.invalidEmail++;
        out(`${code}: invalid_email (Stripe rejected the email address; fix it in the CSV)`);
        continue;
      }
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
      out(`${code}: failed (${describeFailure(error)})`);
    }
  }
  out(JSON.stringify(tally));
  return tally.failed ? 1 : 0;
}

// Direct-run guard (CommonJS build): importing this module, as the tests do, runs nothing.
if (typeof require !== "undefined" && require.main === module) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
