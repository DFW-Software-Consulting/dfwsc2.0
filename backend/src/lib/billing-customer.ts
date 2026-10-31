import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "../db/client";
import { billingCustomers } from "../db/schema";
import { stripe } from "./stripe";

// DFWSC's own billing Customers, on the platform Stripe account. Separate from Stripe
// Connect (clients, Express accounts, payment_ledger): never passes `stripeAccount`, never
// touches those tables. The link between a client code and its Customer lives only in
// billing_customers; a matched Customer is never modified in Stripe.

export type BillingCustomerResult =
  | { status: "linked"; stripeCustomerId: string; source: "created" | "matched" | "backfill" }
  | { status: "ambiguous" }
  /** Stripe refused the email itself (invalid_request_error on `email`); nothing was created. */
  | { status: "invalid_email" };

export interface BillingCustomerInput {
  clientCode: string;
  company: string;
  email: string;
  submissionId?: number;
  /** "backfill" is recorded when the Customer is only being linked after the fact. */
  linkSource?: "backfill";
}

/** Thrown for a Stripe failure; retryable decides whether onboarding backs off or fails. */
export class BillingCustomerStripeError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly invalidEmail = false
  ) {
    super(code);
    this.name = "BillingCustomerStripeError";
  }
}

function classifyStripeError(error: unknown): BillingCustomerStripeError {
  if (error instanceof BillingCustomerStripeError) return error;
  if (error instanceof Stripe.errors.StripeError) {
    const status = error.statusCode;
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      (error as { param?: string }).param === "email"
    ) {
      return new BillingCustomerStripeError("stripe.customer:invalid_email", false, true);
    }
    // 401/403 (rotated or restricted key) are operator-fixable, so they are retried under
    // the usual backoff and attempt cap instead of ending the submission as failed.
    const retryable =
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeRateLimitError ||
      error instanceof Stripe.errors.StripeAPIError ||
      (typeof status === "number" &&
        (status >= 500 || status === 429 || status === 409 || status === 401 || status === 403));
    return new BillingCustomerStripeError(
      `stripe.customer:${status ?? error.type ?? "error"}`,
      retryable
    );
  }
  return new BillingCustomerStripeError("stripe.customer:internal_error", true);
}

/** Plain address check (one @, no spaces, a dot in the domain); Stripe does the rest. */
export function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function idempotencyKey(email: string): string {
  return `onboarding-customer-${crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex")}`;
}

async function findInStripe(email: string): Promise<string[]> {
  const trimmed = email.trim();
  const variants = [...new Set([trimmed.toLowerCase(), trimmed])];
  const ids = new Set<string>();
  for (const variant of variants) {
    const page = await stripe.customers.list({ email: variant, limit: 10 });
    for (const customer of page.data) ids.add(customer.id);
  }
  return [...ids];
}

async function link(
  input: BillingCustomerInput,
  stripeCustomerId: string,
  source: "created" | "matched" | "backfill"
): Promise<BillingCustomerResult> {
  const inserted = await db
    .insert(billingCustomers)
    .values({
      clientCode: input.clientCode,
      company: input.company,
      email: normalizeEmail(input.email),
      stripeCustomerId,
      source,
    })
    .onConflictDoNothing({ target: billingCustomers.clientCode })
    .returning({ stripeCustomerId: billingCustomers.stripeCustomerId });
  if (inserted[0]) return { status: "linked", stripeCustomerId, source };
  // Lost a race (or a retry after an unsaved result): the row already there wins.
  const [existing] = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.clientCode, input.clientCode));
  return {
    status: "linked",
    stripeCustomerId: existing.stripeCustomerId,
    source: existing.source,
  };
}

type Existing =
  | { kind: "own"; stripeCustomerId: string; source: "created" | "matched" | "backfill" }
  | { kind: "known" | "stripe"; stripeCustomerId: string }
  | { kind: "ambiguous" }
  | { kind: "none" };

/** Read-only lookup: this client code, then our table by email, then Stripe by email. */
export async function findExistingBillingCustomer(
  input: Pick<BillingCustomerInput, "clientCode" | "email">
): Promise<Existing> {
  const [own] = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.clientCode, input.clientCode));
  if (own) return { kind: "own", stripeCustomerId: own.stripeCustomerId, source: own.source };

  const lowered = normalizeEmail(input.email);
  const known = await db
    .selectDistinct({ stripeCustomerId: billingCustomers.stripeCustomerId })
    .from(billingCustomers)
    .where(sql`lower(${billingCustomers.email}) = ${lowered}`);
  if (known.length === 1) return { kind: "known", stripeCustomerId: known[0].stripeCustomerId };
  if (known.length > 1) return { kind: "ambiguous" };

  let ids: string[];
  try {
    ids = await findInStripe(input.email);
  } catch (error) {
    throw classifyStripeError(error);
  }
  if (ids.length > 1) return { kind: "ambiguous" };
  if (ids.length === 1) return { kind: "stripe", stripeCustomerId: ids[0] };
  return { kind: "none" };
}

/**
 * Finds or creates the billing Customer for a client code. Idempotent: calling it again
 * for the same code returns the same Customer without another Stripe write.
 * Throws BillingCustomerStripeError on Stripe failures.
 */
export async function ensureBillingCustomer(
  input: BillingCustomerInput
): Promise<BillingCustomerResult> {
  try {
    return await resolveBillingCustomer(input);
  } catch (error) {
    if (error instanceof BillingCustomerStripeError && error.invalidEmail) {
      return { status: "invalid_email" };
    }
    throw error;
  }
}

async function resolveBillingCustomer(input: BillingCustomerInput): Promise<BillingCustomerResult> {
  const existing = await findExistingBillingCustomer(input);
  if (existing.kind === "own") {
    return {
      status: "linked",
      stripeCustomerId: existing.stripeCustomerId,
      source: existing.source,
    };
  }
  if (existing.kind === "ambiguous") return { status: "ambiguous" };
  // source = how the link came about: "created" by us, "matched" to an existing Customer,
  // or "backfill" for any existing Customer linked by the backfill script.
  if (existing.kind === "known" || existing.kind === "stripe") {
    return link(input, existing.stripeCustomerId, input.linkSource ?? "matched");
  }

  try {
    const created = await stripe.customers.create(
      {
        name: input.company,
        email: input.email.trim(),
        metadata: {
          client_code: input.clientCode,
          source: "dfwsc-onboarding",
          ...(input.submissionId !== undefined
            ? { submission_id: String(input.submissionId) }
            : {}),
        },
      },
      // Keyed on the email only, so two client codes of one business converge on one Customer;
      // the resulting idempotency conflict (different params) is handled below.
      { idempotencyKey: idempotencyKey(input.email) }
    );
    return link(input, created.id, "created");
  } catch (error) {
    if (error instanceof Stripe.errors.StripeIdempotencyError) {
      // Another client code for the same email created it within 24h with other params.
      // list is consistent, so the Customer is findable now.
      let again: string[];
      try {
        again = await findInStripe(input.email);
      } catch (listError) {
        throw classifyStripeError(listError);
      }
      if (again.length === 1) return link(input, again[0], "matched");
      if (again.length > 1) return { status: "ambiguous" };
    }
    throw classifyStripeError(error);
  }
}

/**
 * Operator tool: links a client code to a specific Customer (resolves "ambiguous", pins a
 * known one). Confirms it exists and is not deleted; never modifies it.
 */
export async function linkPinnedBillingCustomer(
  input: BillingCustomerInput,
  stripeCustomerId: string
): Promise<BillingCustomerResult> {
  let found: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    found = await stripe.customers.retrieve(stripeCustomerId);
  } catch (error) {
    throw classifyStripeError(error);
  }
  if (found.deleted) throw new BillingCustomerStripeError("stripe.customer:deleted", false);
  return link(input, stripeCustomerId, "backfill");
}
