import type { FastifyBaseLogger } from "fastify";
import type Stripe from "stripe";
import { withStripeCircuit } from "./circuit-breakers";
import { ConcurrencyLimitError, ConcurrencyLimiter } from "./concurrency-limiter";
import { withMirrorLock } from "./mirror-table";
import { getNextcloudConfig, ledgerSyncRequest, type NextcloudConfig } from "./nextcloud";

/**
 * Ledger sync: records Stripe invoice lifecycle into the DFWSC bookkeeping
 * systems hosted on Nextcloud. It runs from the account-level billing webhook
 * (routes/webhooks-billing.ts), the only endpoint that receives platform-account
 * invoice events.
 *
 *  - NextLedger (custom Nextcloud app): on `invoice.paid`, one income entry
 *    (gross amount) plus one expense entry (the exact Stripe processing fee,
 *    read from the charge's balance transaction) in the fiscal year matching
 *    the payment date. Fiscal years are auto-created on rollover.
 *  - OpenRegister "Pipelinq" register: a Ledger Invoice object mirroring the
 *    Stripe invoice, upserted by `stripe_invoice_id` on every lifecycle event
 *    (finalized/paid/payment_failed/voided/marked_uncollectible).
 *
 * Enabled only when LEDGER_SYNC_ENABLED=true and the shared NEXTCLOUD_* service
 * account is configured (lib/nextcloud.ts); otherwise every entry point is a
 * no-op.
 *
 * Race safety: every write for one Stripe invoice runs under a Postgres
 * session advisory lock keyed by the invoice id (withMirrorLock, try-lock).
 * Different events of one invoice (invoice.paid and a redelivery, or a
 * lifecycle event) therefore never interleave. A delivery that finds the lock
 * held throws LedgerSyncBusyError, so the webhook releases its claim and
 * Stripe retries later. Under the lock each write is check-then-insert against
 * Nextcloud itself (the source of truth): entries are found by the Stripe
 * invoice id in their description, register objects by `stripe_invoice_id`. A
 * crash or Nextcloud error between the income and the fee expense is healed by
 * the retry, which books only what is missing.
 *
 * Nextcloud API quirk: mutating requests must send `OCS-APIRequest: true`
 * (lib/nextcloud.ts does).
 */

export interface LedgerSyncConfig {
  nextcloud: NextcloudConfig;
  registerId: string;
  invoiceSchemaId: string;
}

/** Another delivery holds this invoice's lock; the webhook answers non-2xx so Stripe retries. */
export class LedgerSyncBusyError extends Error {
  constructor(readonly invoiceId: string) {
    super("Ledger sync for this invoice is already in progress");
    this.name = "LedgerSyncBusyError";
  }
}

const NEXTLEDGER_API = "/index.php/apps/nextledger/api";
const OPENREGISTER_API = "/index.php/apps/openregister/api";

// Fiscal-year boundaries use the business's home timezone offset
// (America/Chicago standard time), matching the years created manually.
const FISCAL_TZ_OFFSET = "-06:00";
const FISCAL_TZ_OFFSET_HOURS = -6;

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

// Each sync pins a pg connection (the advisory lock) for its Nextcloud round trips, so at most a
// few run at once per process and the rest wait briefly; a call that cannot get a slot is told to
// retry. The pool has 10 connections; a fiscal-year creation briefly holds a second one.
const ledgerSyncLimiter = new ConcurrencyLimiter({
  maxConcurrent: 3,
  maxWaiting: 20,
  maxWaitMs: 10_000,
});

async function underLedgerLimit<T>(invoiceId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await ledgerSyncLimiter.run(work);
  } catch (err) {
    if (err instanceof ConcurrencyLimitError) {
      throw new LedgerSyncBusyError(invoiceId);
    }
    throw err;
  }
}

export function resolveLedgerSyncConfig(
  env: NodeJS.ProcessEnv = process.env
): LedgerSyncConfig | null {
  if (env.LEDGER_SYNC_ENABLED?.trim() !== "true") {
    return null;
  }
  const nextcloud = getNextcloudConfig(env);
  if (!nextcloud.ok) {
    return null;
  }
  return {
    nextcloud: nextcloud.config,
    registerId: env.OPENREGISTER_REGISTER_ID?.trim() || "1",
    invoiceSchemaId: env.OPENREGISTER_INVOICE_SCHEMA_ID?.trim() || "9",
  };
}

function resolveOrWarn(logger: FastifyBaseLogger): LedgerSyncConfig | null {
  const cfg = resolveLedgerSyncConfig();
  if (!cfg && process.env.LEDGER_SYNC_ENABLED?.trim() === "true") {
    logger.warn("Ledger sync is enabled but the NEXTCLOUD_* service account is not usable.");
  }
  return cfg;
}

// Request paths contain invoice ids, so every call carries a fixed PII-free label for errors.
async function ncJson<T>(
  cfg: LedgerSyncConfig,
  method: "GET" | "POST" | "PUT",
  path: string,
  label: string,
  body?: unknown
): Promise<T> {
  const res = await ledgerSyncRequest(cfg.nextcloud, {
    method,
    path,
    label,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`Nextcloud answered a non-JSON body for ${label}`);
  }
}

/**
 * Walks a paginated listing page by page until `matches` finds an item. Stops when a page is
 * empty, repeats only items already seen (the server ignored the paging parameters and returned
 * everything), or the server reports the last page. A short page is NOT the last page: a server
 * may cap `limit` below ours. Running out of MAX_PAGES is never
 * read as "not found": that would book twice.
 */
async function findInPages<T extends { id: string | number }>(
  fetchPage: (page: number, offset: number) => Promise<{ items: T[]; pages?: number }>,
  matches: (item: T) => boolean,
  label: string
): Promise<T | undefined> {
  const seen = new Set<string | number>();
  let received = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    // The offset counts what the server actually returned, so a smaller page cap loses nothing.
    const { items, pages } = await fetchPage(page, received);
    received += items.length;
    const found = items.find(matches);
    if (found) {
      return found;
    }
    const fresh = items.filter((item) => !seen.has(item.id));
    for (const item of fresh) {
      seen.add(item.id);
    }
    if (items.length === 0 || fresh.length === 0 || (pages !== undefined && page >= pages)) {
      return undefined;
    }
  }
  throw new Error(`Nextcloud listing for ${label} exceeded ${MAX_PAGES} pages`);
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

async function listFiscalYears(cfg: LedgerSyncConfig): Promise<FiscalYear[]> {
  return ncJson<FiscalYear[]>(
    cfg,
    "GET",
    `${NEXTLEDGER_API}/fiscal-years`,
    "ledger.fiscal-years.list"
  );
}

const coveringYear = (years: FiscalYear[], paidAtSec: number) =>
  years.find((fy) => fy.dateStart <= paidAtSec && paidAtSec <= fy.dateEnd);

async function ensureFiscalYear(
  cfg: LedgerSyncConfig,
  paidAtSec: number,
  logger: FastifyBaseLogger,
  invoiceId: string
): Promise<FiscalYear> {
  const match = coveringYear(await listFiscalYears(cfg), paidAtSec);
  if (match) {
    return match;
  }
  // The year is read in the same fixed offset the range is built with, so a payment late on
  // Dec 31 local time (already Jan 1 UTC) lands in the year that actually contains it.
  const year = new Date((paidAtSec + FISCAL_TZ_OFFSET_HOURS * 3600) * 1000).getUTCFullYear();
  // The per-invoice lock does not stop two different invoices from creating the same year, so
  // creation is serialized per year, and the list is read again once the lock is held.
  const outcome = await withMirrorLock<FiscalYear | "busy">(
    `ledger_sync:fiscal-year:${year}`,
    logger,
    "busy",
    async () => {
      const again = coveringYear(await listFiscalYears(cfg), paidAtSec);
      if (again) {
        return again;
      }
      return ncJson<FiscalYear>(
        cfg,
        "POST",
        `${NEXTLEDGER_API}/fiscal-years`,
        "ledger.fiscal-years.create",
        {
          name: `FY ${year}`,
          dateStart: Math.floor(Date.parse(`${year}-01-01T00:00:00${FISCAL_TZ_OFFSET}`) / 1000),
          dateEnd: Math.floor(Date.parse(`${year}-12-31T23:59:59${FISCAL_TZ_OFFSET}`) / 1000),
          isActive: false,
        }
      );
    }
  );
  if (outcome === "busy") {
    throw new LedgerSyncBusyError(invoiceId);
  }
  return outcome;
}

/** True when `description` names this exact invoice id (not another id that it prefixes). */
function mentionsInvoice(description: string | null | undefined, invoiceId: string): boolean {
  if (!description) {
    return false;
  }
  const escaped = invoiceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(description);
}

/** The booked entry for this invoice in a fiscal year's `incomes` or `expenses`, if any. */
function findBookedEntry(
  cfg: LedgerSyncConfig,
  fiscalYearId: number,
  kind: "incomes" | "expenses",
  invoiceId: string
): Promise<LedgerEntry | undefined> {
  return findInPages<LedgerEntry>(
    async (_page, offset) => {
      const items = await ncJson<LedgerEntry[]>(
        cfg,
        "GET",
        `${NEXTLEDGER_API}/fiscal-years/${fiscalYearId}/${kind}?limit=${PAGE_SIZE}&offset=${offset}`,
        `ledger.${kind}.list`
      );
      return { items: Array.isArray(items) ? items : [] };
    },
    (entry) => mentionsInvoice(entry.description, invoiceId),
    `ledger.${kind}.list`
  );
}

interface PaymentDetails {
  feeCents: number;
  paymentMethod: string;
}

/**
 * Resolve the charge behind a paid invoice and read the exact Stripe fee off
 * its balance transaction. Only invoices with no payment objects at all (marked paid
 * out-of-band, or $0) book with a zero fee; a real payment without a balance transaction throws.
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
  const chargeBacked = paid.payment.type === "payment_intent" || paid.payment.type === "charge";
  if (!balanceTx && chargeBacked) {
    // A real payment whose fee cannot be read yet: booking income with a zero fee would lose the
    // fee for good, so fail and let Stripe retry. (No payment objects at all returned above.)
    logger.warn({ invoiceId }, "No balance transaction found for a paid invoice payment.");
    throw new Error("Ledger sync: balance transaction not available for a paid invoice payment");
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
    _dfwsc_client_id:
      typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? ""),
    status: invoice.status ?? "open",
    currency: invoice.currency,
    amount_due_cents: invoice.amount_due,
    subtotal_cents: invoice.subtotal,
    tax_cents: 0,
    amount_paid_cents: invoice.amount_paid,
    amount_remaining_cents: invoice.amount_remaining,
    description: firstLineDescription(invoice),
    line_items_json: JSON.stringify(lineItems),
  };
  if (paymentMethod) payload.payment_method = paymentMethod;
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
  status?: string;
}

function findRegisterObject(
  cfg: LedgerSyncConfig,
  base: string,
  invoiceId: string
): Promise<RegisterObject | undefined> {
  return findInPages<RegisterObject>(
    async (page) => {
      // The stripe_invoice_id filter lets OpenRegister narrow the listing server-side; the exact
      // match below and the paging cover a server that ignores it.
      const list = await ncJson<{ results?: RegisterObject[]; pages?: number }>(
        cfg,
        "GET",
        `${base}?limit=${PAGE_SIZE}&page=${page}&stripe_invoice_id=${encodeURIComponent(invoiceId)}`,
        "ledger.register.list"
      );
      return { items: list.results ?? [], pages: list.pages };
    },
    (o) => o.stripe_invoice_id === invoiceId,
    "ledger.register.list"
  );
}

async function upsertRegisterInvoice(
  cfg: LedgerSyncConfig,
  invoice: Stripe.Invoice,
  paymentMethod: string,
  logger: FastifyBaseLogger
): Promise<void> {
  const base = `${OPENREGISTER_API}/objects/${cfg.registerId}/${cfg.invoiceSchemaId}`;
  const invoiceId = invoice.id as string;
  const existing = await findRegisterObject(cfg, base, invoiceId);
  const payload = buildRegisterPayload(invoice, paymentMethod);
  if (existing) {
    // A lifecycle event delivered late (finalized after paid) must not reopen a paid invoice.
    if (existing.status === "paid" && payload.status !== "paid") {
      logger.info(
        { invoiceId, objectId: existing.id, status: payload.status },
        "Ledger sync: register invoice already paid; keeping it."
      );
      return;
    }
    await ncJson(cfg, "PUT", `${base}/${existing.id}`, "ledger.register.update", payload);
    logger.info(
      { invoiceId, objectId: existing.id, status: payload.status },
      "Ledger sync: updated register invoice."
    );
  } else {
    await ncJson(cfg, "POST", base, "ledger.register.create", payload);
    logger.info({ invoiceId, status: payload.status }, "Ledger sync: created register invoice.");
  }
}

async function bookPaidInvoice(
  cfg: LedgerSyncConfig,
  invoice: Stripe.Invoice,
  invoiceId: string,
  paidAt: number,
  payment: PaymentDetails,
  logger: FastifyBaseLogger
): Promise<void> {
  const { feeCents, paymentMethod } = payment;
  const fiscalYear = await ensureFiscalYear(cfg, paidAt, logger, invoiceId);
  const label = invoiceLabel(invoice);

  if (await findBookedEntry(cfg, fiscalYear.id, "incomes", invoiceId)) {
    logger.info({ invoiceId }, "Ledger sync: income already booked; skipping.");
  } else {
    const paymentNote =
      paymentMethod === "out_of_band"
        ? "marked paid out-of-band (no Stripe charge)"
        : `paid via ${paymentMethod}`;
    await ncJson(
      cfg,
      "POST",
      `${NEXTLEDGER_API}/fiscal-years/${fiscalYear.id}/incomes`,
      "ledger.incomes.create",
      {
        name: `${label} — ${invoiceClientName(invoice)}`,
        description: `Stripe invoice ${invoiceId}; ${firstLineDescription(invoice)}; ${paymentNote}`,
        bookedAt: paidAt,
        amountCents: invoice.amount_paid,
        status: "paid",
      }
    );
    logger.info(
      { invoiceId, fiscalYearId: fiscalYear.id, amountCents: invoice.amount_paid },
      "Ledger sync: booked income."
    );
  }

  if (feeCents > 0) {
    if (await findBookedEntry(cfg, fiscalYear.id, "expenses", invoiceId)) {
      logger.info({ invoiceId }, "Ledger sync: fee expense already booked; skipping.");
    } else {
      await ncJson(
        cfg,
        "POST",
        `${NEXTLEDGER_API}/fiscal-years/${fiscalYear.id}/expenses`,
        "ledger.expenses.create",
        {
          name: `Stripe fee — ${label}`,
          description: `Processing fee for Stripe invoice ${invoiceId} (${invoiceClientName(invoice)})`,
          bookedAt: paidAt,
          amountCents: feeCents,
        }
      );
      logger.info(
        { invoiceId, fiscalYearId: fiscalYear.id, feeCents },
        "Ledger sync: booked Stripe fee expense."
      );
    }
  }

  await upsertRegisterInvoice(cfg, invoice, paymentMethod, logger);
}

/**
 * Book a paid platform-account invoice: income + fee expense in NextLedger,
 * plus a register upsert. Connected-account events must be skipped by passing
 * the webhook event's `account` field.
 *
 * Throws on any failure, including LedgerSyncBusyError, so the webhook releases
 * its claim and Stripe redelivers; a redelivery books only what is still missing.
 */
export async function syncInvoicePaid(
  stripeClient: Stripe,
  invoice: Stripe.Invoice,
  logger: FastifyBaseLogger,
  connectedAccount?: string | null,
  eventCreated?: number
): Promise<void> {
  const cfg = resolveOrWarn(logger);
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

  // The booking date must be the same on every retry, or the lookup would search another fiscal
  // year: paid_at, else the event's own time (never the clock).
  const paidAt =
    invoice.status_transitions?.paid_at ?? eventCreated ?? Math.floor(Date.now() / 1000);

  // Read from Stripe before taking the lock, so no database connection waits on Stripe. Safe to
  // reuse under the lock: a paid invoice's payment and its fee never change.
  const payment = await resolvePaymentDetails(stripeClient, invoiceId, logger);

  const outcome = await underLedgerLimit(invoiceId, () =>
    withMirrorLock(`ledger_sync:${invoiceId}`, logger, "busy" as "busy" | "done", async () => {
      await bookPaidInvoice(cfg, invoice, invoiceId, paidAt, payment, logger);
      return "done";
    })
  );
  if (outcome === "busy") {
    throw new LedgerSyncBusyError(invoiceId);
  }
}

/**
 * Mirror a non-payment lifecycle change (finalized, payment_failed, voided,
 * marked_uncollectible) into the register. NextLedger is untouched: no money
 * moved. This is a status mirror only, so it is best effort: a Nextcloud error
 * or a busy lock is logged and never fails the webhook. (`invoice.paid` is the
 * one event whose ledger booking must retry, and it writes the final status.)
 */
export async function syncInvoiceLifecycle(
  invoice: Stripe.Invoice,
  logger: FastifyBaseLogger,
  connectedAccount?: string | null
): Promise<void> {
  const cfg = resolveOrWarn(logger);
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
  if (!invoiceId) {
    return;
  }
  try {
    const outcome = await underLedgerLimit(invoiceId, () =>
      withMirrorLock(`ledger_sync:${invoiceId}`, logger, "busy" as "busy" | "done", async () => {
        await upsertRegisterInvoice(cfg, invoice, "", logger);
        return "done";
      })
    );
    if (outcome === "busy") {
      // Dropped on purpose: invoice.paid writes the final status. A dropped voided or
      // uncollectible event can leave the register at "open".
      logger.warn(
        { invoiceId, status: invoice.status },
        "Ledger sync: invoice busy; dropped a register status update."
      );
    }
  } catch (err) {
    logger.warn(
      { invoiceId, errorName: err instanceof Error ? err.name : "unknown" },
      "Ledger sync: register status update failed; continuing."
    );
  }
}
