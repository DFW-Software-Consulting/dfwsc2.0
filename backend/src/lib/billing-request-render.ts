import type { billingRequestSubmissions } from "../db/schema";
import { type PlanInterval, planSummary } from "./billing-request-mapping";
import { type ColumnSpec, formatDateTime, type RenderedValues } from "./portal-mirror-render";

// Pure rendering of the read-only "Billing Requests" Nextcloud Table. One row per submission of the
// "New invoice" form. No I/O. Only ids and codes are shown: no description, memo, company name or
// customer email. The Stripe link is the dashboard URL of the invoice or the schedule.

export const BILLING_REQUESTS_TABLE_TITLE = "Billing Requests";
export const BILLING_REQUESTS_STATE_KEY = "billing_requests_table_id";

export function billingRequestColumns(): ColumnSpec[] {
  return [
    { key: "submitted", title: "Submitted", type: "datetime" },
    { key: "by", title: "By", type: "text" },
    { key: "clientCode", title: "Client Code", type: "text" },
    { key: "type", title: "Type", type: "text" },
    { key: "amount", title: "Amount", type: "number", decimals: 2, prefix: "$" },
    { key: "plan", title: "Plan", type: "text" },
    { key: "status", title: "Status", type: "text" },
    { key: "error", title: "Error", type: "text" },
    { key: "stripe", title: "Stripe", type: "text" },
  ];
}

type RequestRow = typeof billingRequestSubmissions.$inferSelect;

const KIND_LABELS = { one_off: "One-off invoice", recurring: "Recurring plan" } as const;
const OUTCOME_LABELS = { sent: "Sent", draft: "Draft created", scheduled: "Scheduled" } as const;

/** Test-mode keys get /test/ dashboard links. */
function dashboardBase(): string {
  return process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
    ? "https://dashboard.stripe.com/test"
    : "https://dashboard.stripe.com";
}

export function stripeInvoiceUrl(invoiceId: string): string {
  return `${dashboardBase()}/invoices/${invoiceId}`;
}
export function stripeScheduleUrl(scheduleId: string): string {
  return `${dashboardBase()}/subscription_schedules/${scheduleId}`;
}

export function billingRequestStatus(row: Pick<RequestRow, "status" | "outcome">): string {
  if (row.status === "failed") return "Failed";
  if (row.status === "completed" && row.outcome) return OUTCOME_LABELS[row.outcome];
  return "Processing";
}

export function renderBillingRequest(row: RequestRow): RenderedValues {
  const plan =
    row.kind === "recurring" &&
    row.amountCents !== null &&
    row.planInterval &&
    row.planPayments !== null &&
    row.planStartDate
      ? planSummary({
          amountCents: row.amountCents,
          interval: row.planInterval as PlanInterval,
          payments: row.planPayments,
          startDate: row.planStartDate,
        })
      : "";
  // Shown even for a failed request that got as far as creating something in Stripe, so the
  // operator can find it.
  const link = row.stripeInvoiceId
    ? stripeInvoiceUrl(row.stripeInvoiceId)
    : row.stripeScheduleId
      ? stripeScheduleUrl(row.stripeScheduleId)
      : "";
  return {
    submitted: row.submittedAt ? formatDateTime(row.submittedAt) : null,
    by: row.requestedBy ?? "",
    clientCode: row.clientCode ?? "",
    type: row.kind ? KIND_LABELS[row.kind] : "",
    amount: row.amountCents === null ? null : Math.round(row.amountCents) / 100,
    plan,
    status: billingRequestStatus(row),
    error: row.lastErrorCode ?? "",
    stripe: link,
  };
}
