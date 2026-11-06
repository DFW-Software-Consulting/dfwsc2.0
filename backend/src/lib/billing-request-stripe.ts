import Stripe from "stripe";
import type { billingRequestSubmissions } from "../db/schema";
import { type BillingRequest, planStripeShape } from "./billing-request-mapping";
import { isCircuitOpenError, isStripeBusyError, withStripeCircuit } from "./circuit-breakers";
import { stripe } from "./stripe";

// The Stripe side of the "New invoice" form (lib/billing-request-sync.ts). DFWSC's own platform
// account only: no call passes `stripeAccount`, and nothing here updates, voids, cancels or
// deletes an existing object. It only creates the objects of one request, and reads (retrieve,
// list, search) to resume one.
//
// One-off invoice: invoice (draft, nothing else attached) -> invoice item -> finalize -> send.
// Recurring plan: product -> Subscription Schedule starting at the chosen date 09:00 Chicago.
//
// Idempotency: every call carries the key `ncbill-{formId}-{submissionId}-{step}`, and the id of
// each created object is saved in the claim row before the next call, so a retry resumes where the
// last attempt stopped. Stripe forgets a key after 24 hours, and a lost response leaves no saved
// id, so once an earlier attempt may have sent a create, every retry first looks for the object by
// its metadata (nc_form, nc_submission) with a paginated list, and adopts what it finds, before
// creating anything or refusing for a reason that depends on time.
//
// Logs (by the caller) carry ids and codes only.

export type RequestRow = typeof billingRequestSubmissions.$inferSelect;

/** A failure of one Stripe step, already classified. `code` is PII-free. */
export class BillingRequestStripeError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    /** Stripe as a whole looks unavailable: the cycle should stop instead of trying the next row. */
    readonly stopCycle = false
  ) {
    super(code);
    this.name = "BillingRequestStripeError";
  }
}

/**
 * 429, 5xx, no answer (connection) and an open breaker (or a full queue) are retried with backoff.
 * 409 is Stripe saying the same idempotency key is still in flight: also retried. Every other 4xx
 * (bad request, auth, permission, idempotency mismatch) is permanent.
 */
function classifyBillingStripeError(step: string, error: unknown): BillingRequestStripeError {
  if (error instanceof BillingRequestStripeError) return error;
  if (isCircuitOpenError(error))
    return new BillingRequestStripeError("stripe.circuit_open", true, true);
  if (isStripeBusyError(error)) return new BillingRequestStripeError("stripe.busy", true, true);
  if (error instanceof Stripe.errors.StripeError) {
    if (error instanceof Stripe.errors.StripeConnectionError) {
      return new BillingRequestStripeError(`stripe.${step}:connection`, true);
    }
    const status = error.statusCode;
    const retryable =
      error instanceof Stripe.errors.StripeRateLimitError ||
      error instanceof Stripe.errors.StripeAPIError ||
      (typeof status === "number" && (status >= 500 || status === 429 || status === 409));
    return new BillingRequestStripeError(
      `stripe.${step}:${status ?? error.type ?? "error"}`,
      retryable
    );
  }
  return new BillingRequestStripeError(`stripe.${step}:internal_error`, true);
}

async function call<T>(step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await withStripeCircuit(action);
  } catch (error) {
    throw classifyBillingStripeError(step, error);
  }
}

export interface StripeJob {
  formId: number;
  submissionId: number;
  stripeCustomerId: string;
  request: BillingRequest;
  autoSend: boolean;
  daysUntilDue: number;
  /** Unix seconds of the plan's first invoice (recurring only). */
  startUnix: number | null;
  /** The plan's start time has passed: refuse, but only after looking for a schedule that exists. */
  startPassed: boolean;
  /**
   * The request is older than the age limit and no Stripe id is saved: it resumes only if the
   * lookup finds an object of its own; otherwise it is refused as expired before any create.
   */
  expiredUnlessFound: boolean;
}

export type Save = (patch: Partial<typeof billingRequestSubmissions.$inferInsert>) => Promise<void>;

const idempotencyKey = (formId: number, submissionId: number, step: string) =>
  `ncbill-${formId}-${submissionId}-${step}`;

export type StripeOutcome = "sent" | "draft" | "scheduled";

const PAGE_SIZE = 100;
/** Pages read by one lookup (10,000 objects). Beyond that creating could duplicate, so it refuses. */
const MAX_PAGES = 100;

interface Page<T> {
  data: T[];
  has_more?: boolean;
}

/** Reads a Stripe list page by page until `accept` finds an item (or the list ends). */
async function findInList<T extends { id: string }>(
  step: string,
  fetchPage: (startingAfter: string | undefined) => Promise<Page<T>>,
  accept: (item: T) => boolean
): Promise<T | undefined> {
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const current = await call(step, () => fetchPage(startingAfter));
    const found = current.data.find(accept);
    if (found) return found;
    if (!current.has_more || current.data.length === 0) return undefined;
    startingAfter = current.data[current.data.length - 1].id;
  }
  throw new BillingRequestStripeError(`stripe.${step}:too_many`, false);
}

/** Same for a Stripe search (cursor `next_page`). */
async function findInSearch<T extends { id: string }>(
  step: string,
  fetchPage: (page: string | undefined) => Promise<Page<T> & { next_page?: string | null }>
): Promise<T | undefined> {
  let cursor: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const current = await call(step, () => fetchPage(cursor));
    if (current.data[0]) return current.data[0];
    if (!current.has_more || !current.next_page) return undefined;
    cursor = current.next_page;
  }
  throw new BillingRequestStripeError(`stripe.${step}:too_many`, false);
}

/**
 * Read-only check before anything is created: the Customer exists, is not deleted and has an email
 * (a send_invoice invoice or plan cannot be emailed without one).
 */
async function preflightCustomer(customerId: string): Promise<void> {
  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await call("customer", () => stripe.customers.retrieve(customerId));
  } catch (error) {
    if (error instanceof BillingRequestStripeError && error.code === "stripe.customer:404") {
      throw new BillingRequestStripeError("customer_missing", false);
    }
    throw error;
  }
  if (customer.deleted) throw new BillingRequestStripeError("customer_missing", false);
  if (!customer.email?.trim()) throw new BillingRequestStripeError("customer_no_email", false);
}

/**
 * Runs the Stripe steps still missing for the request. `save` persists a patch under the claim and
 * mirrors it into `row`, so what `row` holds is always what is already saved.
 *
 * Order for every missing object: the id saved in `row`; else, if an earlier attempt may have sent
 * the create, a metadata lookup; only then a create. A first attempt starts with the Customer check.
 */
export async function runStripeSteps(
  row: RequestRow,
  job: StripeJob,
  save: Save
): Promise<StripeOutcome> {
  const { formId, submissionId, request } = job;
  const key = (step: string) => ({ idempotencyKey: idempotencyKey(formId, submissionId, step) });
  const metadata = {
    nc_form: String(formId),
    nc_submission: String(submissionId),
    client_code: request.clientCode,
  };

  // An earlier attempt called Stripe, so anything it created may exist without a saved id.
  const priorAttempt = row.stripeStartedAt !== null;
  if (!priorAttempt && !row.stripeInvoiceId && !row.stripeProductId && !row.stripeScheduleId) {
    await preflightCustomer(job.stripeCustomerId);
  }
  // Set before the first create: the marker that a create may have been sent.
  if (!row.stripeStartedAt) await save({ stripeStartedAt: new Date() });

  const isOurs = (m: Stripe.Metadata | null | undefined) =>
    m?.nc_form === metadata.nc_form && m?.nc_submission === metadata.nc_submission;
  // Narrows the customer-wide lists to what was created since the request was made.
  const createdSince = Math.floor((row.submittedAt ?? row.createdAt).getTime() / 1000) - 3600;

  if (request.kind === "one_off") {
    // 1. The invoice, a draft with nothing attached (pending items of the Customer stay out).
    if (!row.stripeInvoiceId) {
      let id: string | undefined;
      if (priorAttempt) {
        id = (
          await findInList(
            "invoice_lookup",
            (after) =>
              stripe.invoices.list({
                customer: job.stripeCustomerId,
                created: { gte: createdSince },
                limit: PAGE_SIZE,
                ...(after ? { starting_after: after } : {}),
              }),
            (invoice) => isOurs(invoice.metadata)
          )
        )?.id;
      }
      if (!id) {
        if (job.expiredUnlessFound) throw new BillingRequestStripeError("request_expired", false);
        const invoice = await call("invoice", () =>
          stripe.invoices.create(
            {
              customer: job.stripeCustomerId,
              currency: "usd",
              collection_method: "send_invoice",
              days_until_due: job.daysUntilDue,
              pending_invoice_items_behavior: "exclude",
              auto_advance: false,
              ...(request.memo ? { description: request.memo } : {}),
              metadata,
            },
            key("invoice")
          )
        );
        id = invoice.id;
      }
      await save({ stripeInvoiceId: id });
    }
    const invoiceId = row.stripeInvoiceId as string;

    // 2. The one line on it.
    if (!row.stripeInvoiceItemId) {
      let id: string | undefined;
      if (priorAttempt) {
        id = (
          await findInList(
            "item_lookup",
            (after) =>
              stripe.invoiceItems.list({
                invoice: invoiceId,
                limit: PAGE_SIZE,
                ...(after ? { starting_after: after } : {}),
              }),
            (item) => isOurs(item.metadata)
          )
        )?.id;
      }
      if (!id) {
        const item = await call("item", () =>
          stripe.invoiceItems.create(
            {
              invoice: invoiceId,
              customer: job.stripeCustomerId,
              amount: request.amountCents,
              currency: "usd",
              description: request.description,
              metadata,
            },
            key("item")
          )
        );
        id = item.id;
      }
      await save({ stripeInvoiceItemId: id });
    }

    if (!job.autoSend) return "draft";

    // 3. Finalize, 4. send. After an earlier attempt, an invoice that is no longer a draft was
    // finalized by an attempt whose result was lost.
    if (!row.invoiceFinalizedAt) {
      let alreadyFinal = false;
      if (priorAttempt) {
        const current = await call("invoice_lookup", () => stripe.invoices.retrieve(invoiceId));
        alreadyFinal = current.status !== "draft";
      }
      if (!alreadyFinal) {
        await call("finalize", () =>
          stripe.invoices.finalizeInvoice(invoiceId, {}, key("finalize"))
        );
      }
      await save({ invoiceFinalizedAt: new Date() });
    }
    if (!row.invoiceSentAt) {
      // A lost send can mean the customer is emailed twice; never not at all.
      await call("send", () => stripe.invoices.sendInvoice(invoiceId, {}, key("send")));
      await save({ invoiceSentAt: new Date() });
    }
    return "sent";
  }

  // Recurring plan.
  if (job.startUnix === null) throw new BillingRequestStripeError("start_date_missing", false);
  if (!row.stripeScheduleId) {
    // The schedule may exist (create applied, answer lost) even if its start has since passed.
    let found: string | undefined;
    if (priorAttempt) {
      found = (
        await findInList(
          "schedule_lookup",
          (after) =>
            stripe.subscriptionSchedules.list({
              customer: job.stripeCustomerId,
              created: { gte: createdSince },
              limit: PAGE_SIZE,
              ...(after ? { starting_after: after } : {}),
            }),
          (schedule) => isOurs(schedule.metadata)
        )
      )?.id;
    }
    if (found) {
      await save({ stripeScheduleId: found });
      return "scheduled";
    }
    if (job.expiredUnlessFound) throw new BillingRequestStripeError("request_expired", false);
    if (job.startPassed) throw new BillingRequestStripeError("start_date_passed", false);
  }
  if (!row.stripeProductId) {
    let id: string | undefined;
    if (priorAttempt && !row.stripeScheduleId) {
      id = (
        await findInSearch("product_lookup", (page) =>
          stripe.products.search({
            query: metadataQuery(formId, submissionId),
            limit: 1,
            ...(page ? { page } : {}),
          })
        )
      )?.id;
    }
    if (!id) {
      const product = await call("product", () =>
        stripe.products.create({ name: request.description, metadata }, key("product"))
      );
      id = product.id;
    }
    await save({ stripeProductId: id });
  }
  const productId = row.stripeProductId as string;

  if (!row.stripeScheduleId) {
    const shape = planStripeShape(request.interval, request.payments);
    const schedule = await call("schedule", () =>
      stripe.subscriptionSchedules.create(
        {
          customer: job.stripeCustomerId,
          start_date: job.startUnix as number,
          end_behavior: "cancel",
          default_settings: {
            collection_method: "send_invoice",
            invoice_settings: { days_until_due: job.daysUntilDue },
          },
          phases: [
            {
              items: [
                {
                  price_data: {
                    currency: "usd",
                    product: productId,
                    unit_amount: request.amountCents,
                    recurring: shape.recurring,
                  },
                  quantity: 1,
                },
              ],
              // On the 2025-09-30.clover API a phase is `duration`; `iterations` is gone.
              duration: shape.duration,
              ...(request.memo ? { description: request.memo } : {}),
              metadata,
            },
          ],
          metadata,
        },
        key("schedule")
      )
    );
    await save({ stripeScheduleId: schedule.id });
  }
  return "scheduled";
}

const metadataQuery = (formId: number, submissionId: number) =>
  `metadata['nc_form']:'${formId}' AND metadata['nc_submission']:'${submissionId}'`;
