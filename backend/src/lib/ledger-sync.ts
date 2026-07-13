import type { FastifyBaseLogger } from "fastify";
import type Stripe from "stripe";
import { withStripeCircuit } from "./circuit-breakers";

/**
 * Ledger sync — records Stripe invoice lifecycle into the DFWSC bookkeeping
 * systems hosted on Nextcloud:
 *
 *  - NextLedger (custom Nextcloud app): on `invoice.paid`, one income entry
 *    (gross amount) plus one expense entry (the exact Stripe processing fee,
 *    read from the charge's balance transaction) in the fiscal year matching
 *    the payment date. Fiscal years are auto-created on rollover.
 *  - OpenRegister "Pipelinq" register: a Ledger Invoice object mirroring the
 *    Stripe invoice, upserted by `stripe_invoice_id` on every lifecycle event
 *    (finalized/paid/payment_failed/voided/marked_uncollectible).
 *
 * The sync is enabled only when NEXTCLOUD_URL, NEXTCLOUD_LEDGER_USER and
 * NEXTCLOUD_APP_PASSWORD are all set; otherwise every entry point is a no-op
 * so environments without the integration keep working.
 *
 * Idempotency: NextLedger entries are looked up by the Stripe invoice id
 * embedded in their description before booking, and register objects are
 * updated in place when one with the same stripe_invoice_id exists. Failures
 * throw, so the webhook releases its claim and Stripe redelivers.
 *
 * Nextcloud API quirk: mutating requests must send `OCS-APIRequest: true`.
 */

export interface LedgerSyncConfig {
  baseUrl: string;
  user: string;
  appPassword: string;
  registerId: string;
  invoiceSchemaId: string;
}

const NEXTLEDGER_API = "/index.php/apps/nextledger/api";
const OPENREGISTER_API = "/index.php/apps/openregister/api";

// Fiscal-year boundaries use the business's home timezone offset
// (America/Chicago standard time), matching the years created manually.
const FISCAL_TZ_OFFSET = "-06:00";

export function resolveLedgerSyncConfig(
  env: NodeJS.ProcessEnv = process.env
): LedgerSyncConfig | null {
  const baseUrl = env.NEXTCLOUD_URL?.trim().replace(/\/+$/, "");
  const user = env.NEXTCLOUD_LEDGER_USER?.trim();
  const appPassword = env.NEXTCLOUD_APP_PASSWORD?.trim();
  if (!baseUrl || !user || !appPassword) {
    return null;
  }
  return {
    baseUrl,
    user,
    appPassword,
    registerId: env.OPENREGISTER_REGISTER_ID?.trim() || "1",
    invoiceSchemaId: env.OPENREGISTER_INVOICE_SCHEMA_ID?.trim() || "9",
  };
}

async function ncJson<T>(cfg: LedgerSyncConfig, path: string, init: RequestInit = {}): Promise<T> {
  const credentials = Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString("base64");
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${credentials}`,
      "OCS-APIRequest": "true",
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(
      `Nextcloud request failed: ${init.method ?? "GET"} ${path} -> HTTP ${res.status}`
    );
  }
  return (await res.json()) as T;
}

interface FiscalYear {
  id: number;
  name: string;
  dateStart: number;
  dateEnd: number;
  isActive: boolean;
}

interface LedgerEntry {
  id: number;
  name: string;
  description: string | null;
  bookedAt: number;
  amountCents: number;
}

async function ensureFiscalYear(cfg: LedgerSyncConfig, paidAtSec: number): Promise<FiscalYear> {
  const years = await ncJson<FiscalYear[]>(cfg, `${NEXTLEDGER_API}/fiscal-years`);
  const match = years.find((fy) => fy.dateStart <= paidAtSec && paidAtSec <= fy.dateEnd);
  if (match) {
    return match;
  }
  const year = new Date(paidAtSec * 1000).getUTCFullYear();
  return ncJson<FiscalYear>(cfg, `${NEXTLEDGER_API}/fiscal-years`, {
    method: "POST",
    body: JSON.stringify({
      name: `FY ${year}`,
      dateStart: Math.floor(Date.parse(`${year}-01-01T00:00:00${FISCAL_TZ_OFFSET}`) / 1000),
      dateEnd: Math.floor(Date.parse(`${year}-12-31T23:59:59${FISCAL_TZ_OFFSET}`) / 1000),
      isActive: false,
    }),
  });
}

interface PaymentDetails {
  feeCents: number;
  paymentMethod: string;
}

/**
 * Resolve the charge behind a paid invoice and read the exact Stripe fee off
 * its balance transaction. Invoices marked paid out-of-band have no payment
 * objects and book with a zero fee.
 */
async function resolvePaymentDetails(
  stripeClient: Stripe,
  invoiceId: string,
  logger: FastifyBaseLogger
): Promise<PaymentDetails> {
  const payments = await withStripeCircuit(() =>
    stripeClient.invoicePayments.list({ invoice: invoiceId, limit: 10 })
  );
  const paid = payments.data.find((p) => p.status === "paid") ?? payments.data[0];
  if (!paid) {
    return { feeCents: 0, paymentMethod: "out_of_band" };
  }

  let charge: Stripe.Charge | null = null;
  if (paid.payment.type === "payment_intent" && paid.payment.payment_intent) {
    const piId =
      typeof paid.payment.payment_intent === "string"
        ? paid.payment.payment_intent
        : paid.payment.payment_intent.id;
    const intent = await withStripeCircuit(() =>
      stripeClient.paymentIntents.retrieve(piId, {
        expand: ["latest_charge.balance_transaction"],
      })
    );
    charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  } else if (paid.payment.type === "charge" && paid.payment.charge) {
    const chargeId =
      typeof paid.payment.charge === "string" ? paid.payment.charge : paid.payment.charge.id;
    charge = await withStripeCircuit(() =>
      stripeClient.charges.retrieve(chargeId, { expand: ["balance_transaction"] })
    );
  }

  const balanceTx =
    charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  if (!balanceTx) {
    logger.warn(
      { invoiceId },
      "No balance transaction found for paid invoice; booking income without a fee expense."
    );
  }
  return {
    feeCents: balanceTx?.fee ?? 0,
    paymentMethod: charge?.payment_method_details?.type ?? paid.payment.type,
  };
}

function invoiceLabel(invoice: Stripe.Invoice): string {
  return invoice.number ?? invoice.id ?? "unknown";
}

function invoiceClientName(invoice: Stripe.Invoice): string {
  return invoice.customer_name ?? invoice.customer_email ?? "";
}

function firstLineDescription(invoice: Stripe.Invoice): string {
  return invoice.lines?.data?.[0]?.description ?? "";
}

function isoFromUnix(sec: number | null | undefined): string | undefined {
  return sec ? new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;
}

function buildRegisterPayload(
  invoice: Stripe.Invoice,
  paymentMethod: string
): Record<string, unknown> {
  const lineItems = (invoice.lines?.data ?? []).map((line) => ({
    description: line.description,
    quantity: line.quantity,
    amount_cents: line.amount,
  }));
  const payload: Record<string, unknown> = {
    name: invoiceLabel(invoice),
    type: "invoice",
    stripe_invoice_id: invoice.id,
    client_name: invoice.customer_name ?? "",
    client_email: invoice.customer_email ?? "",
    _dfwsc_client_id: typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? ""),
    status: invoice.status ?? "open",
    currency: invoice.currency,
    amount_due_cents: invoice.amount_due,
    subtotal_cents: invoice.subtotal,
    tax_cents: 0,
    amount_paid_cents: invoice.amount_paid,
    amount_remaining_cents: invoice.amount_remaining,
    description: firstLineDescription(invoice),
    line_items_json: JSON.stringify(lineItems),
    payment_method: paymentMethod,
  };
  const created = isoFromUnix(invoice.created);
  const dueDate = isoFromUnix(invoice.due_date);
  const paidAt = isoFromUnix(invoice.status_transitions?.paid_at);
  if (created) payload.created_at = created;
  if (dueDate) payload.due_date = dueDate;
  if (paidAt) payload.paid_at = paidAt;
  if (invoice.hosted_invoice_url) payload.hosted_invoice_url = invoice.hosted_invoice_url;
  return payload;
}

interface RegisterObject {
  id: string;
  stripe_invoice_id?: string;
}

async function upsertRegisterInvoice(
  cfg: LedgerSyncConfig,
  invoice: Stripe.Invoice,
  paymentMethod: string,
  logger: FastifyBaseLogger
): Promise<void> {
  const base = `${OPENREGISTER_API}/objects/${cfg.registerId}/${cfg.invoiceSchemaId}`;
  const list = await ncJson<{ results?: RegisterObject[] }>(cfg, `${base}?limit=1000`);
  const existing = (list.results ?? []).find((o) => o.stripe_invoice_id === invoice.id);
  const payload = buildRegisterPayload(invoice, paymentMethod);
  if (existing) {
    await ncJson(cfg, `${base}/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) });
    logger.info(
      { invoiceId: invoice.id, objectId: existing.id, status: payload.status },
      "Ledger sync: updated register invoice."
    );
  } else {
    await ncJson(cfg, base, { method: "POST", body: JSON.stringify(payload) });
    logger.info(
      { invoiceId: invoice.id, status: payload.status },
      "Ledger sync: created register invoice."
    );
  }
}

/**
 * Book a paid platform-account invoice: income + fee expense in NextLedger,
 * plus a register upsert. Connected-account events must be skipped by passing
 * the webhook event's `account` field.
 */
export async function syncInvoicePaid(
  stripeClient: Stripe,
  invoice: Stripe.Invoice,
  logger: FastifyBaseLogger,
  connectedAccount?: string | null
): Promise<void> {
  const cfg = resolveLedgerSyncConfig();
  if (!cfg) {
    return;
  }
  if (connectedAccount) {
    logger.debug(
      { invoiceId: invoice.id, account: connectedAccount },
      "Ledger sync: skipping connected-account invoice."
    );
    return;
  }
  const invoiceId = invoice.id;
  if (!invoiceId || !invoice.amount_paid) {
    logger.debug({ invoiceId }, "Ledger sync: nothing to book for zero-amount invoice.");
    return;
  }

  const paidAt = invoice.status_transitions?.paid_at ?? Math.floor(Date.now() / 1000);
  const { feeCents, paymentMethod } = await resolvePaymentDetails(stripeClient, invoiceId, logger);
  const fiscalYear = await ensureFiscalYear(cfg, paidAt);
  const label = invoiceLabel(invoice);

  const incomes = await ncJson<LedgerEntry[]>(
    cfg,
    `${NEXTLEDGER_API}/fiscal-years/${fiscalYear.id}/incomes`
  );
  if (incomes.some((entry) => entry.description?.includes(invoiceId))) {
    logger.info({ invoiceId }, "Ledger sync: income already booked; skipping.");
  } else {
    const paymentNote =
      paymentMethod === "out_of_band"
        ? "marked paid out-of-band (no Stripe charge)"
        : `paid via ${paymentMethod}`;
    await ncJson(cfg, `${NEXTLEDGER_API}/fiscal-years/${fiscalYear.id}/incomes`, {
      method: "POST",
      body: JSON.stringify({
        name: `${label} — ${invoiceClientName(invoice)}`,
        description: `Stripe invoice ${invoiceId}; ${firstLineDescription(invoice)}; ${paymentNote}`,
        bookedAt: paidAt,
        amountCents: invoice.amount_paid,
        status: "paid",
      }),
    });
    logger.info(
      { invoiceId, fiscalYearId: fiscalYear.id, amountCents: invoice.amount_paid },
      "Ledger sync: booked income."
    );
  }

  if (feeCents > 0) {
    const expenses = await ncJson<LedgerEntry[]>(
      cfg,
      `${NEXTLEDGER_API}/fiscal-years/${fiscalYear.id}/expenses`
    );
    if (expenses.some((entry) => entry.description?.includes(invoiceId))) {
      logger.info({ invoiceId }, "Ledger sync: fee expense already booked; skipping.");
    } else {
      await ncJson(cfg, `${NEXTLEDGER_API}/fiscal-years/${fiscalYear.id}/expenses`, {
        method: "POST",
        body: JSON.stringify({
          name: `Stripe fee — ${label}`,
          description: `Processing fee for Stripe invoice ${invoiceId} (${invoiceClientName(invoice)})`,
          bookedAt: paidAt,
          amountCents: feeCents,
        }),
      });
      logger.info(
        { invoiceId, fiscalYearId: fiscalYear.id, feeCents },
        "Ledger sync: booked Stripe fee expense."
      );
    }
  }

  await upsertRegisterInvoice(cfg, invoice, paymentMethod, logger);
}

/**
 * Mirror a non-payment lifecycle change (finalized, payment_failed, voided,
 * marked_uncollectible) into the register. NextLedger is untouched: no money
 * moved.
 */
export async function syncInvoiceLifecycle(
  invoice: Stripe.Invoice,
  logger: FastifyBaseLogger,
  connectedAccount?: string | null
): Promise<void> {
  const cfg = resolveLedgerSyncConfig();
  if (!cfg) {
    return;
  }
  if (connectedAccount) {
    logger.debug(
      { invoiceId: invoice.id, account: connectedAccount },
      "Ledger sync: skipping connected-account invoice."
    );
    return;
  }
  if (!invoice.id) {
    return;
  }
  await upsertRegisterInvoice(cfg, invoice, "", logger);
}
