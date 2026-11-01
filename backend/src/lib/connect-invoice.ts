import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";
import type { connectInvoices } from "../db/schema";
import { INVOICE_MAX_AMOUNT_CENTS, INVOICE_MAX_LINES } from "./constants";
import { AppError } from "./errors";
import { MAX_SAFE_AMOUNT } from "./stripe-input";

// Pure helpers for the connected-account invoice routes: request validation, the money math, the
// canonical request hash used by the idempotency check, the response serializer and the list
// cursor. Nothing here talks to Stripe or Postgres.

export type InvoiceRow = typeof connectInvoices.$inferSelect;

/**
 * Statuses after which nothing more can happen to an invoice, so it is never re-checked.
 * `uncollectible` is not one: Stripe can still move it to paid or void.
 */
export const TERMINAL_INVOICE_STATUSES = ["paid", "void", "deleted"] as const;
const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible", "deleted"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * For each status, the stored statuses it may overwrite. A row only ever moves forward (draft ->
 * open -> uncollectible -> paid or void), so a late or replayed answer (an `open` read after the
 * invoice was paid) can never move it back. Same status is allowed (amounts and URLs refresh).
 */
export const INVOICE_STATUS_PRIORS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["draft"],
  open: ["draft", "open"],
  uncollectible: ["draft", "open", "uncollectible"],
  paid: ["draft", "open", "uncollectible", "paid"],
  void: ["draft", "open", "uncollectible", "void"],
  deleted: ["draft", "deleted"],
};

const RESERVED_METADATA_PREFIX = "dfwsc_";

/**
 * The row columns that mirror a Stripe invoice. Used by every path that reads an invoice back from
 * Stripe (lifecycle writes, the GET re-check). Returns null for an invoice without a status.
 * `metadata` is the caller's own (the `dfwsc_` bookkeeping keys are not exposed).
 */
export function invoicePatchFromStripe(invoice: Stripe.Invoice) {
  const status = invoice.status;
  if (!status) return null;
  const at = (s: number | null | undefined) => (s ? new Date(s * 1000) : undefined);
  const t = invoice.status_transitions;
  const metadata = Object.fromEntries(
    Object.entries(invoice.metadata ?? {}).filter(([k]) => !k.startsWith(RESERVED_METADATA_PREFIX))
  );
  return {
    status,
    totalCents: invoice.total,
    amountPaidCents: invoice.amount_paid,
    amountRemainingCents: invoice.amount_remaining,
    number: invoice.number ?? null,
    dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null,
    description: invoice.description ?? null,
    metadata,
    ...(at(t?.finalized_at) ? { finalizedAt: at(t?.finalized_at) } : {}),
    ...(at(t?.paid_at) ? { paidAt: at(t?.paid_at) } : {}),
    ...(at(t?.voided_at) ? { voidedAt: at(t?.voided_at) } : {}),
    lastSyncedAt: new Date(),
  };
}

export const PROCESSING_FEE_DESCRIPTION = "Processing Fee";

const lineSchema = z.object({
  description: z
    .string({ error: "line description is required." })
    .trim()
    .min(1, "line description is required.")
    .max(500, "line description must not exceed 500 characters."),
  unitAmountCents: z
    .number({ error: "line unitAmountCents is required." })
    .int("unitAmountCents must be an integer.")
    .positive("unitAmountCents must be positive.")
    .max(MAX_SAFE_AMOUNT, `unitAmountCents must not exceed ${MAX_SAFE_AMOUNT}.`),
  quantity: z
    .number()
    .int("quantity must be an integer.")
    .min(1, "quantity must be at least 1.")
    .max(999_999, "quantity must not exceed 999999.")
    .default(1),
});

const optionalText = (max: number, field: string) =>
  z
    .string()
    .trim()
    .max(max, `${field} must not exceed ${max} characters.`)
    .optional()
    // An empty string means "none", so it hashes and sends the same as an absent field.
    .transform((v) => (v ? v : undefined));

// Unknown keys are dropped (like the payments and customers bodies). That is what makes a
// `waiveFee` field inert: API keys can never waive the fee. `finalize` and `send` are refused
// separately, in the route, so they are never silently ignored.
export const createInvoiceBodySchema = z.object({
  customerId: z
    .string({ error: "customerId is required." })
    .trim()
    .min(1, "customerId is required.")
    .max(255, "customerId must not exceed 255 characters."),
  lines: z
    .array(lineSchema, { error: "lines is required." })
    .min(1, "lines must contain at least one line.")
    .max(INVOICE_MAX_LINES, `lines must not exceed ${INVOICE_MAX_LINES} items.`),
  currency: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .refine((v) => v === "usd", { message: "currency must be 'usd'; only USD is supported." })
    .optional(),
  daysUntilDue: z
    .number()
    .int("daysUntilDue must be an integer.")
    .min(1, "daysUntilDue must be between 1 and 365.")
    .max(365, "daysUntilDue must be between 1 and 365.")
    .optional(),
  description: optionalText(1500, "description"),
  footer: optionalText(500, "footer"),
  metadata: z.record(z.string(), z.string()).optional(),
});

export type CreateInvoiceBody = z.infer<typeof createInvoiceBodySchema>;
export type InvoiceLineInput = CreateInvoiceBody["lines"][number];

export const listQuerySchema = z.object({
  status: z
    .enum(INVOICE_STATUSES, { error: `status must be one of: ${INVOICE_STATUSES.join(", ")}.` })
    .optional(),
  customerId: z.string().trim().min(1).max(255).optional(),
  limit: z.coerce
    .number({ error: "limit must be an integer between 1 and 100." })
    .int("limit must be an integer between 1 and 100.")
    .min(1, "limit must be an integer between 1 and 100.")
    .max(100, "limit must be an integer between 1 and 100.")
    .default(25),
  cursor: z.string().max(512, "cursor is invalid.").optional(),
});

const tooLarge = () =>
  new AppError(
    `Invoice total must not exceed ${INVOICE_MAX_AMOUNT_CENTS} cents.`,
    400,
    "INVOICE_AMOUNT_TOO_LARGE"
  );

/**
 * The base subtotal, summed server-side with safe-integer checks. A caller-supplied total is never
 * read. Throws a 400 when a line or the sum is unsafe or already above the invoice cap.
 */
export function computeBaseCents(lines: readonly InvoiceLineInput[]): number {
  let base = 0;
  for (const line of lines) {
    const lineTotal = line.unitAmountCents * line.quantity;
    if (!Number.isSafeInteger(lineTotal)) {
      throw new AppError("Line item total exceeds safe integer bounds.", 400, "BAD_REQUEST");
    }
    if (lineTotal > INVOICE_MAX_AMOUNT_CENTS) throw tooLarge();
    base += lineTotal;
    if (!Number.isSafeInteger(base) || base > INVOICE_MAX_AMOUNT_CENTS) throw tooLarge();
  }
  if (base <= 0) {
    throw new AppError("Computed base amount must be positive.", 400, "BAD_REQUEST");
  }
  return base;
}

/** The total (base + fee) must also fit the cap. */
export function assertTotalWithinCap(totalCents: number): void {
  if (!Number.isSafeInteger(totalCents) || totalCents > INVOICE_MAX_AMOUNT_CENTS) throw tooLarge();
}

export interface InvoiceRequest {
  customerId: string;
  lines: Array<{ description: string; unitAmountCents: number; quantity: number }>;
  currency: "usd";
  /** As the caller sent it (null when omitted): the client's default is resolved at send time. */
  daysUntilDue: number | null;
  description: string | null;
  footer: string | null;
  userMetadata: Record<string, string>;
}

/**
 * sha256 of a canonical JSON of the validated request: fixed key order, metadata sorted by key,
 * `daysUntilDue` as the caller sent it (not the client's default terms, which can change between
 * an attempt and its retry). The same request always hashes the same; any
 * change to a field, a line or the line order changes it.
 */
export function hashInvoiceRequest(req: InvoiceRequest): string {
  const metadata = Object.entries(req.userMetadata).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const canonical = JSON.stringify({
    customerId: req.customerId,
    lines: req.lines.map((l) => [l.description, l.unitAmountCents, l.quantity]),
    currency: req.currency,
    daysUntilDue: req.daysUntilDue,
    description: req.description,
    footer: req.footer,
    metadata,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The whitelisted view of an invoice. Built from the Postgres row only: never the raw Stripe
 * object. Hosted URLs are bearer links, so they appear in the response and nowhere in logs.
 * `subtotalCents` is the sum of the lines before the processing fee; `totalCents` includes it.
 */
export function serializeInvoice(row: InvoiceRow) {
  return {
    id: row.stripeInvoiceId,
    number: row.number ?? null,
    status: row.status,
    customerId: row.stripeCustomerId,
    currency: row.currency,
    subtotalCents: row.subtotalCents,
    feeAmountCents: row.feeAmountCents,
    totalCents: row.totalCents,
    amountPaidCents: row.amountPaidCents,
    amountRemainingCents: row.amountRemainingCents,
    dueDate: iso(row.dueDate),
    hostedInvoiceUrl: row.hostedInvoiceUrl ?? null,
    invoicePdf: row.invoicePdf ?? null,
    description: row.description ?? null,
    metadata: (row.metadata as Record<string, string> | null) ?? {},
    createdAt: row.createdAt.toISOString(),
    finalizedAt: iso(row.finalizedAt),
    paidAt: iso(row.paidAt),
    voidedAt: iso(row.voidedAt),
  };
}

// ── List cursor ────────────────────────────────────────────────────────────────
// Opaque base64url of the last row's (created_at, id). created_at is always written from a JS Date
// (millisecond precision), so the round trip through the cursor is exact.
const cursorSchema = z.object({ c: z.string().datetime(), i: z.string().min(1).max(64) });

export function encodeCursor(row: Pick<InvoiceRow, "createdAt" | "id">): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    "base64url"
  );
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    if (!parsed.success) return null;
    return { createdAt: new Date(parsed.data.c), id: parsed.data.i };
  } catch {
    return null;
  }
}
