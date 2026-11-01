import { formatDateTime } from "./portal-mirror-render";

// Pure derivation of one billing Customer's status from Stripe subscription, schedule and invoice
// LISTS (lib/billing-snapshot.ts fetches them read-only). No I/O, no clock besides `now`.
// The types are structural subsets of the Stripe objects, so Stripe's own objects are accepted.
//
// Status, first match wins:
//   Late    a subscription is past_due or unpaid; an open invoice with a balance is past its due
//           date (Late starts the UTC day after due_date, no grace period); a charge_automatically open invoice has a failed attempt; an
//           invoice is uncollectible (counts as Late until it is voided).
//   Active  a subscription is active, trialing or paused; a schedule is not_started or active; an
//           open invoice is not yet due.
//   Ended   a subscription or schedule was canceled or completed, or an invoice was paid, and
//           nothing is live.
//   None    nothing (draft, void and incomplete_expired are ignored everywhere).
// Next Due: the earliest future date; failing that, the oldest overdue open invoice's due date.
// Finished plans sort last: " (done)" when canceled, completed, or all payments of a finite plan are
// paid with nothing open or past_due/unpaid; " (ended)" for a canceled open-ended plan.
// "Up to date" is No exactly when the overdue amount is above zero (or overdue in another currency).

export interface BillingPrice {
  unit_amount: number | null;
  currency: string;
  recurring?: { interval: string; interval_count: number } | null;
}

export interface BillingScheduleInput {
  status: string;
  phases?: {
    start_date: number;
    end_date?: number | null;
    /** Not part of Stripe's response today; honoured when present. */
    iterations?: number | null;
  }[];
}

export interface BillingSubscriptionInput {
  id: string;
  status: string;
  start_date: number;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  items: {
    data: {
      quantity?: number | null;
      price?: BillingPrice | null;
      current_period_end?: number | null;
    }[];
  };
  schedule?: string | BillingScheduleInput | null;
}

export interface BillingInvoiceInput {
  id: string;
  status: string | null;
  currency: string;
  amount_paid: number;
  amount_remaining: number;
  due_date?: number | null;
  created?: number | null;
  collection_method?: string | null;
  attempt_count?: number | null;
  next_payment_attempt?: number | null;
  status_transitions?: { paid_at?: number | null } | null;
  parent?: {
    subscription_details?: { subscription?: string | { id: string } | null } | null;
  } | null;
}

export interface BillingInput {
  subscriptions: BillingSubscriptionInput[];
  /** Schedules with no subscription yet (not_started). */
  schedules: BillingScheduleInput[];
  invoices: BillingInvoiceInput[];
  now: Date;
}

export type BillingStatus = "Late" | "Active" | "Ended" | "None";

/** The Stripe-derived columns of a Client Billing row, as stored in billing_snapshots.rendered. */
export type BillingValues = {
  status: BillingStatus;
  upToDate: "Yes" | "No";
  subscription: string;
  paymentsMade: string;
  amountPaid: number;
  nextDue: string | null;
  /** Null when an open invoice is not in USD (the amount is then not summed). */
  openBalance: number | null;
  /** Null when an overdue invoice is not in USD. */
  overdue: number | null;
  lastPayment: string | null;
  /** An open or overdue invoice is in another currency: shown as "(non-USD)" next to Status. */
  nonUsd: boolean;
};

const IGNORED_INVOICE = new Set(["draft", "void"]);
const IGNORED_SUBSCRIPTION = new Set(["incomplete", "incomplete_expired"]);
const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "paused"]);
const LIVE_SCHEDULE = new Set(["not_started", "active"]);
const ENDED_SCHEDULE = new Set(["completed", "canceled"]);

const isUsd = (currency: string) => currency.toLowerCase() === "usd";
const dollars = (cents: number) => Math.round(cents) / 100;
const sum = <T>(items: T[], pick: (item: T) => number) =>
  items.reduce((total, item) => total + pick(item), 0);

function formatMoney(cents: number, currency: string): string {
  const body =
    cents % 100 === 0
      ? (cents / 100).toLocaleString("en-US")
      : (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
  return isUsd(currency) ? `$${body}` : `${currency.toUpperCase()} ${body}`;
}

const scheduleOf = (sub: BillingSubscriptionInput): BillingScheduleInput | null =>
  sub.schedule && typeof sub.schedule === "object" ? sub.schedule : null;

const subscriptionIdOf = (invoice: BillingInvoiceInput): string | null => {
  const raw = invoice.parent?.subscription_details?.subscription;
  return typeof raw === "string" ? raw : (raw?.id ?? null);
};

const utcDay = (ms: number) => Math.floor(ms / 86_400_000);

const DAY_SECONDS = 24 * 60 * 60;
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30.4375, year: 365.25 };

/** Whole billing periods between two timestamps; at least one. */
function periodsBetween(startSec: number, endSec: number, interval: string, count: number): number {
  const days = (endSec - startSec) / DAY_SECONDS;
  return Math.max(1, Math.round(days / ((UNIT_DAYS[interval] ?? 30.4375) * Math.max(1, count))));
}

/** How many payments the plan has, or null when open-ended. */
function totalPayments(
  sub: BillingSubscriptionInput,
  interval: string,
  count: number
): number | null {
  const phases = scheduleOf(sub)?.phases ?? [];
  if (phases.length) {
    let total = 0;
    for (const phase of phases) {
      if (phase.iterations) total += phase.iterations;
      else if (phase.end_date)
        total += periodsBetween(phase.start_date, phase.end_date, interval, count);
      else return null;
    }
    return total;
  }
  if (sub.cancel_at) return periodsBetween(sub.start_date, sub.cancel_at, interval, count);
  return null;
}

function describeSubscription(
  sub: BillingSubscriptionInput,
  invoices: BillingInvoiceInput[]
): { text: string; made: string; end: "done" | "ended" | null } {
  const items = sub.items.data;
  const recurring = items.find((i) => i.price?.recurring)?.price?.recurring;
  const currency = items[0]?.price?.currency ?? "usd";
  const priced = items.every((i) => i.price && i.price.unit_amount !== null);
  const interval = recurring?.interval ?? "month";
  const count = recurring?.interval_count ?? 1;
  const cents = sum(items, (i) => (i.price?.unit_amount ?? 0) * (i.quantity ?? 1));
  const unit = count === 1 ? interval : `${count} ${interval}s`;
  const base = priced ? `${formatMoney(cents, currency)}/${unit}` : `Custom amount/${unit}`;
  const payments = totalPayments(sub, interval, count);
  const text = payments === null ? base : `${base} for ${payments * count} ${interval}s`;
  const made = invoices.filter(
    (i) => i.status === "paid" && i.amount_paid > 0 && subscriptionIdOf(i) === sub.id
  ).length;
  // Finished: canceled or completed, or every payment of a finite plan is paid with nothing
  // unpaid left on the subscription. A canceled open-ended plan is "ended" (no known length).
  const unsettled =
    sub.status === "past_due" ||
    sub.status === "unpaid" ||
    invoices.some((i) => i.status === "open" && subscriptionIdOf(i) === sub.id);
  const finite = payments !== null;
  const stopped = sub.status === "canceled" || scheduleOf(sub)?.status === "completed";
  const end: "done" | "ended" | null =
    stopped || (finite && made >= payments && !unsettled) ? (finite ? "done" : "ended") : null;
  return { text, made: finite ? `${made} of ${payments}` : String(made), end };
}

export function deriveBilling(input: BillingInput): BillingValues {
  const nowMs = input.now.getTime();
  const subscriptions = input.subscriptions.filter((s) => !IGNORED_SUBSCRIPTION.has(s.status));
  const invoices = input.invoices.filter(
    (i) => i.status !== null && !IGNORED_INVOICE.has(i.status)
  );
  const schedules = [
    ...subscriptions.map(scheduleOf).filter((s): s is BillingScheduleInput => s !== null),
    ...input.schedules,
  ];

  const open = invoices.filter((i) => i.status === "open" && i.amount_remaining > 0);
  const pastDue = open.filter(
    (i) =>
      (i.due_date != null && utcDay(i.due_date * 1000) < utcDay(nowMs)) ||
      (i.collection_method === "charge_automatically" && (i.attempt_count ?? 0) > 0)
  );
  const uncollectible = invoices.filter((i) => i.status === "uncollectible");
  const overdueInvoices = [...pastDue, ...uncollectible];

  const late =
    subscriptions.some((s) => s.status === "past_due" || s.status === "unpaid") ||
    overdueInvoices.length > 0;
  const live =
    subscriptions.some((s) => LIVE_SUBSCRIPTION.has(s.status)) ||
    schedules.some((s) => LIVE_SCHEDULE.has(s.status)) ||
    open.length > 0;
  const ended =
    subscriptions.some((s) => s.status === "canceled") ||
    schedules.some((s) => ENDED_SCHEDULE.has(s.status)) ||
    invoices.some((i) => i.status === "paid");

  const status: BillingStatus = late ? "Late" : live ? "Active" : ended ? "Ended" : "None";

  const usd = <T extends { currency: string }>(items: T[]) =>
    items.filter((i) => isUsd(i.currency));
  const overdueCents = sum(usd(overdueInvoices), (i) => i.amount_remaining);
  const nonUsdOverdue = overdueInvoices.some((i) => !isUsd(i.currency));
  const nonUsdOpen = open.some((i) => !isUsd(i.currency));
  const lastPaid = Math.max(
    0,
    ...invoices.filter((i) => i.amount_paid > 0).map((i) => i.status_transitions?.paid_at ?? 0)
  );

  // Earliest upcoming date: an open invoice not yet due, the next renewal of a live subscription
  // that will renew, or the start of a schedule that has not begun.
  const upcoming: number[] = [];
  for (const invoice of open) {
    if (pastDue.includes(invoice)) continue;
    const at = invoice.due_date ?? invoice.next_payment_attempt;
    if (at != null && at * 1000 > nowMs) upcoming.push(at * 1000);
  }
  for (const sub of subscriptions) {
    if (sub.status !== "active" && sub.status !== "trialing") continue;
    for (const item of sub.items.data) {
      const end = item.current_period_end;
      if (end == null || end * 1000 <= nowMs) continue;
      const ends = sub.cancel_at_period_end || (sub.cancel_at != null && sub.cancel_at <= end);
      if (!ends) upcoming.push(end * 1000);
    }
  }
  for (const schedule of input.schedules) {
    const start = schedule.phases?.[0]?.start_date;
    if (start != null && start * 1000 > nowMs) upcoming.push(start * 1000);
  }

  // Nothing in the future: the oldest overdue open invoice is the payment still waiting. This
  // covers past_due/unpaid subscriptions too, whose unpaid invoice is one of the overdue ones.
  if (!upcoming.length) {
    // No due_date (charge_automatically): next retry, else when the invoice was created.
    const overdueDates = pastDue
      .map((i) => i.due_date ?? i.next_payment_attempt ?? i.created ?? null)
      .filter((d): d is number => d != null);
    if (overdueDates.length) upcoming.push(Math.min(...overdueDates) * 1000);
  }

  const described = subscriptions.map((s) => describeSubscription(s, invoices));
  const livePlans = described.filter((d) => d.end === null);
  const finished = described.filter((d) => d.end !== null);
  const planned = input.schedules.map((s) => {
    const start = s.phases?.[0]?.start_date;
    return start
      ? `Scheduled plan starting ${formatDateTime(new Date(start * 1000)).slice(0, 10)}`
      : "Scheduled plan";
  });

  return {
    status,
    upToDate: overdueCents > 0 || nonUsdOverdue ? "No" : "Yes",
    subscription: [
      ...livePlans.map((d) => d.text),
      ...planned,
      ...finished.map((d) => `${d.text} (${d.end})`),
    ].join("; "),
    paymentsMade: [
      ...livePlans.map((d) => d.made),
      ...planned.map(() => "0"),
      ...finished.map((d) => `${d.made} (${d.end})`),
    ].join("; "),
    amountPaid: dollars(sum(usd(invoices), (i) => i.amount_paid)),
    nextDue: upcoming.length ? formatDateTime(new Date(Math.min(...upcoming))) : null,
    openBalance: nonUsdOpen ? null : dollars(sum(usd(open), (i) => i.amount_remaining)),
    overdue: nonUsdOverdue ? null : dollars(overdueCents),
    lastPayment: lastPaid > 0 ? formatDateTime(new Date(lastPaid * 1000)) : null,
    nonUsd: nonUsdOverdue || nonUsdOpen,
  };
}
