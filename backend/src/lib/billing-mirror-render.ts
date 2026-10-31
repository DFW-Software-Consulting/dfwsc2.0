import type { BillingValues } from "./billing-status";
import { type ColumnSpec, formatDateTime, type RenderedValues } from "./portal-mirror-render";

// Pure rendering of the "Client Billing" mirror (lib/billing-mirror-sync.ts). No I/O.
// The key column is Client Code (the immutable source id), not the first column: it is how a row
// is found again when the mapping is lost (daily reconcile).
//
// Rendered: the client's company, its client code, the Stripe-derived columns of billing_snapshots
// and a link to the Customer in the Stripe dashboard. Never rendered: emails, payment methods,
// invoice ids or any individual invoice.

export const BILLING_TABLE_TITLE = "Client Billing";
export const BILLING_KEY = "clientCode";

const money = (): Pick<ColumnSpec, "type" | "decimals" | "prefix"> => ({
  type: "number",
  decimals: 2,
  prefix: "$",
});

export const BILLING_COLUMN_KEYS = [
  "client",
  "clientCode",
  "upToDate",
  "status",
  "subscription",
  "paymentsMade",
  "amountPaid",
  "nextDue",
  "openBalance",
  "overdue",
  "lastPayment",
  "stripeCustomer",
  "updated",
  "lastChecked",
] as const;

export function billingColumns(): ColumnSpec[] {
  return [
    { key: "client", title: "Client", type: "text" },
    { key: "clientCode", title: "Client Code", type: "text" },
    { key: "upToDate", title: "Up to date", type: "text" },
    { key: "status", title: "Status", type: "text" },
    { key: "subscription", title: "Subscription", type: "text" },
    { key: "paymentsMade", title: "Payments Made", type: "text" },
    { key: "amountPaid", title: "Amount Paid", ...money() },
    { key: "nextDue", title: "Next Due", type: "datetime" },
    { key: "openBalance", title: "Open Balance", ...money() },
    { key: "overdue", title: "Overdue Amount", ...money() },
    { key: "lastPayment", title: "Last Payment", type: "datetime" },
    { key: "stripeCustomer", title: "Stripe Customer", type: "text" },
    { key: "updated", title: "Updated", type: "datetime" },
    { key: "lastChecked", title: "Last Checked", type: "datetime" },
  ];
}

export const stripeCustomerUrl = (customerId: string) =>
  `https://dashboard.stripe.com/customers/${customerId}`;

// Tables' single-line text cells are capped; a long joined subscription list is cut, not refused.
const LINE_MAX = 250;
const line = (text: string) => (text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text);

/**
 * One Client Billing row. `sharedWith` lists the other client codes on the same Stripe Customer:
 * every one of those rows shows the same data, and the Client cell says so.
 *
 * Staleness is visible: `values` null is a Customer with no successful refresh yet ("Pending",
 * or "Check failed" when its first refresh failed); `failed` is a refresh that failed since the
 * last success ("Check failed (was Active)", Up to date blank). Last Checked is the last success.
 * Both change the content hash, so the row is rewritten.
 */
export function renderBillingRow(input: {
  company: string;
  clientCode: string;
  stripeCustomerId: string;
  sharedWith: string[];
  values: BillingValues | null;
  failed: boolean;
  updatedAt: Date | null;
  refreshedAt: Date | null;
}): RenderedValues {
  const { values } = input;
  const note = input.sharedWith.length
    ? ` (shares a Stripe Customer with ${[...input.sharedWith].sort().join(", ")})`
    : "";
  const base = {
    client: line(`${input.company}${note}`),
    clientCode: input.clientCode,
    stripeCustomer: stripeCustomerUrl(input.stripeCustomerId),
    lastChecked: input.refreshedAt ? formatDateTime(input.refreshedAt) : null,
  };
  if (!values) {
    return {
      ...base,
      upToDate: "",
      status: input.failed ? "Check failed" : "Pending",
      subscription: "",
      paymentsMade: "",
      amountPaid: null,
      nextDue: null,
      openBalance: null,
      overdue: null,
      lastPayment: null,
      updated: null,
    };
  }
  const nonUsd = values.nonUsd ? " (non-USD)" : "";
  return {
    ...base,
    upToDate: input.failed ? "" : values.upToDate,
    status: input.failed
      ? `Check failed (was ${values.status}${nonUsd})`
      : `${values.status}${nonUsd}`,
    subscription: line(values.subscription),
    paymentsMade: line(values.paymentsMade),
    amountPaid: values.amountPaid,
    nextDue: values.nextDue,
    openBalance: values.openBalance ?? null,
    overdue: values.overdue ?? null,
    lastPayment: values.lastPayment,
    updated: input.updatedAt ? formatDateTime(input.updatedAt) : null,
  };
}
