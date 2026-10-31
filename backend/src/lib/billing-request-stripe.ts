import Stripe from "stripe";
import type { billingRequestSubmissions } from "../db/schema";
import { type BillingRequest, planStripeShape } from "./billing-request-mapping";
import { isCircuitOpenError, isStripeBusyError, withStripeCircuit } from "./circuit-breakers";
import { BILLING_REQUESTS_KEY_WINDOW_MS } from "./constants";
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
// last attempt stopped. Stripe forgets a key after 24 hours; past BILLING_REQUESTS_KEY_WINDOW_MS a
// retry first looks for the object by its metadata (nc_form, nc_submission) before creating one.
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
}

export type Save = (patch: Partial<typeof billingRequestSubmissions.$inferInsert>) => Promise<void>;

const idempotencyKey = (formId: number, submissionId: number, step: string) =>
  `ncbill-${formId}-${submissionId}-${step}`;

export type StripeOutcome = "sent" | "draft" | "scheduled";

/**
 * Runs the Stripe steps still missing for the request. `save` persists a patch under the claim and
 * mirrors it into `row`, so what `row` holds is always what is already saved.
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

  // Set before the first call: it is the age the 24 h idempotency window is measured from.
  if (!row.stripeStartedAt) await save({ stripeStartedAt: new Date() });
  const keyExpired =
    row.stripeStartedAt !== null &&
    Date.now() - row.stripeStartedAt.getTime() > BILLING_REQUESTS_KEY_WINDOW_MS;
  const metadataQuery = `metadata['nc_form']:'${formId}' AND metadata['nc_submission']:'${submissionId}'`;
  const isOurs = (m: Stripe.Metadata | null | undefined) =>
    m?.nc_form === metadata.nc_form && m?.nc_submission === metadata.nc_submission;

  if (request.kind === "one_off") {
    // 1. The invoice, a draft with nothing attached (pending items of the Customer stay out).
    if (!row.stripeInvoiceId) {
      let id: string | undefined;
      if (keyExpired) {
        const found = await call("invoice_lookup", () =>
          stripe.invoices.search({ query: metadataQuery, limit: 1 })
        );
        id = found.data[0]?.id;
      }
      if (!id) {
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
      if (keyExpired) {
        const items = await call("item_lookup", () =>
          stripe.invoiceItems.list({ invoice: invoiceId, limit: 100 })
        );
        id = items.data.find((item) => isOurs(item.metadata))?.id;
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

    // 3. Finalize, 4. send. Past the key window an invoice that is no longer a draft was
    // finalized by an earlier attempt whose result was lost.
    if (!row.invoiceFinalizedAt) {
      let alreadyFinal = false;
      if (keyExpired) {
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
      // A lost send past the key window can mean the customer is emailed twice; never not at all.
      await call("send", () => stripe.invoices.sendInvoice(invoiceId, {}, key("send")));
      await save({ invoiceSentAt: new Date() });
    }
    return "sent";
  }

  // Recurring plan.
  if (job.startUnix === null) throw new BillingRequestStripeError("start_date_missing", false);
  if (!row.stripeProductId) {
    let id: string | undefined;
    if (keyExpired) {
      const found = await call("product_lookup", () =>
        stripe.products.search({ query: metadataQuery, limit: 1 })
      );
      id = found.data[0]?.id;
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
    let id: string | undefined;
    if (keyExpired) {
      const schedules = await call("schedule_lookup", () =>
        stripe.subscriptionSchedules.list({ customer: job.stripeCustomerId, limit: 100 })
      );
      id = schedules.data.find((s) => isOurs(s.metadata))?.id;
    }
    if (!id) {
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
      id = schedule.id;
    }
    await save({ stripeScheduleId: id });
  }
  return "scheduled";
}
