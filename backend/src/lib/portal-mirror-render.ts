import crypto from "node:crypto";
import type { clientGroups, clients } from "../db/schema";

// Pure rendering of the Portal Accounts mirror (lib/portal-mirror-sync.ts).
// No I/O. The first column of each table holds the immutable source id: it is how a row is
// found again when the mapping is lost (daily reconcile).
//
// Never rendered, on purpose: connected_account_id of payments, phone, address, notes, API keys.
// The client email is shown (owner decision) and can be turned off with MirrorOptions.includeEmail.
//
// Per-account payment columns (Last Payment, Payments (30d), DFWSC Fees (30d)) are aggregates
// only (PaymentSummary, computed in SQL by lib/portal-mirror-sync.ts): no individual payment, id
// or metadata is ever rendered. Adding another computed column is: one ColumnSpec in
// accountColumns, one field in PaymentSummary and its value in renderAccount.

// Only accounts are mirrored. payment_ledger is deliberately NOT mirrored: payment data stays in
// Postgres, the admin panel and Stripe (owner decision). `kind` in portal_mirror_rows stays generic
// so another table could be added later.
export interface ColumnSpec {
  /** Key of the rendered value; the Nextcloud column is found by `title`. */
  key: string;
  title: string;
  type: "text" | "number" | "datetime";
  /** Number columns only. */
  decimals?: number;
  prefix?: string;
}

/** The owner's open choices, each one a switch here (see PORTAL_MIRROR_* in lib/portal-mirror-sync.ts). */
export interface MirrorOptions {
  includeEmail: boolean;
  includeArchived: boolean;
}

export const DEFAULT_MIRROR_OPTIONS: MirrorOptions = {
  includeEmail: true,
  includeArchived: false,
};

export const ACCOUNTS_TABLE_TITLE = "Portal Accounts";

const money = (): Pick<ColumnSpec, "type" | "decimals" | "prefix"> => ({
  type: "number",
  decimals: 2,
  prefix: "$",
});

export function accountColumns(options: MirrorOptions): ColumnSpec[] {
  return [
    { key: "id", title: "Client ID", type: "text" },
    { key: "name", title: "Name", type: "text" },
    ...(options.includeEmail ? [{ key: "email", title: "Email", type: "text" } as ColumnSpec] : []),
    { key: "group", title: "Group", type: "text" },
    { key: "status", title: "Status", type: "text" },
    { key: "stripeAccount", title: "Stripe Account", type: "text" },
    { key: "onboarding", title: "Onboarding", type: "text" },
    { key: "charges", title: "Charges Enabled", type: "text" },
    { key: "payouts", title: "Payouts Enabled", type: "text" },
    { key: "details", title: "Details Submitted", type: "text" },
    { key: "feePercent", title: "Fee %", type: "number", decimals: 2 },
    { key: "feeAmount", title: "Fee $", ...money() },
    { key: "lastPayment", title: "Last Payment", type: "datetime" },
    { key: "payments30d", title: "Payments (30d)", type: "number", decimals: 0 },
    { key: "fees30d", title: "DFWSC Fees (30d)", ...money() },
    { key: "created", title: "Created", type: "datetime" },
    { key: "updated", title: "Updated", type: "datetime" },
  ];
}

/**
 * Aggregates of one client's payment_ledger rows. A payment counts when its status is `paid`, or
 * `refunded` with refunded_amount_cents below total_amount_cents (a partial refund). Created,
 * expired, failed and canceled never count; neither do full refunds or disputes.
 * Fees are the gross fee_amount_cents (the ledger records no fee refunds, so refunds are not
 * netted) and USD only; `payments30d` counts every currency.
 */
export interface PaymentSummary {
  lastPayment: Date | null;
  payments30d: number;
  fees30dCents: number;
}

export const EMPTY_PAYMENT_SUMMARY: PaymentSummary = {
  lastPayment: null,
  payments30d: 0,
  fees30dCents: 0,
};

export type RenderedValues = Record<string, string | number | null>;

const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  pending: "Pending",
  failed: "Failed",
  archived: "Archived",
};

const yesNo = (value: boolean) => (value ? "Yes" : "No");
const dollars = (cents: number) => Math.round(cents) / 100;

/** "YYYY-MM-DD HH:mm" in UTC, the format Nextcloud Tables stores for a datetime column. */
export function formatDateTime(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/** The fee defaults resolveClientFee falls back to (settings table, then DEFAULT_PROCESS_FEE_CENTS). */
export interface FeeDefaults {
  percent: string | null;
  cents: number;
}

type FeeSettings = Pick<typeof clients.$inferSelect, "processingFeePercent" | "processingFeeCents">;

/**
 * The fee a payment would use, in the same precedence as resolveClientFee (lib/stripe-billing.ts):
 * client percent, client cents, group percent, group cents, the default percent, the default
 * cents. Exactly one of the two comes back set.
 */
export function effectiveFee(
  client: FeeSettings,
  group: FeeSettings | null,
  defaults: FeeDefaults
): { percent: number | null; cents: number | null } {
  if (client.processingFeePercent != null)
    return { percent: Number(client.processingFeePercent), cents: null };
  if (client.processingFeeCents != null) return { percent: null, cents: client.processingFeeCents };
  if (group?.processingFeePercent != null)
    return { percent: Number(group.processingFeePercent), cents: null };
  if (group?.processingFeeCents != null) return { percent: null, cents: group.processingFeeCents };
  if (defaults.percent && defaults.percent.trim().length > 0)
    return { percent: Number(defaults.percent), cents: null };
  return { percent: null, cents: defaults.cents };
}

export function onboardingState(
  client: Pick<
    typeof clients.$inferSelect,
    "stripeAccountId" | "chargesEnabled" | "payoutsEnabled" | "detailsSubmitted"
  >
): string {
  if (!client.stripeAccountId) return "Not started";
  if (!client.detailsSubmitted) return "Details needed";
  return client.chargesEnabled && client.payoutsEnabled ? "Ready" : "Under review";
}

export function renderAccount(
  client: typeof clients.$inferSelect,
  group: typeof clientGroups.$inferSelect | null,
  defaults: FeeDefaults,
  options: MirrorOptions,
  summary: PaymentSummary = EMPTY_PAYMENT_SUMMARY
): RenderedValues {
  const fee = effectiveFee(client, group, defaults);
  const values: RenderedValues = {
    id: client.id,
    name: client.name,
    group: group?.name ?? "",
    status: ACCOUNT_STATUS_LABELS[client.status] ?? client.status,
    stripeAccount: client.stripeAccountId ?? "",
    onboarding: onboardingState(client),
    charges: yesNo(client.chargesEnabled),
    payouts: yesNo(client.payoutsEnabled),
    details: yesNo(client.detailsSubmitted),
    feePercent: fee.percent,
    feeAmount: fee.cents === null ? null : dollars(fee.cents),
    lastPayment: summary.lastPayment ? formatDateTime(summary.lastPayment) : null,
    payments30d: summary.payments30d,
    fees30d: dollars(summary.fees30dCents),
    created: formatDateTime(client.createdAt),
    updated: formatDateTime(client.updatedAt),
  };
  if (options.includeEmail) values.email = client.email;
  return values;
}

export function contentHash(values: RenderedValues): string {
  const ordered = Object.keys(values)
    .sort()
    .map((key) => [key, values[key]]);
  return crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/** Rendered values to the `{ [columnId]: value }` body of a Tables row create/update. */
export function toRowData(
  specs: ColumnSpec[],
  columnIds: Map<string, number>,
  values: RenderedValues
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const spec of specs) {
    const id = columnIds.get(spec.key);
    if (id === undefined) continue;
    data[String(id)] = values[spec.key] ?? (spec.type === "text" ? "" : null);
  }
  return data;
}

/** Whether a stored cell already equals the value we would write (tolerant of Tables' echo). */
export function cellMatches(spec: ColumnSpec, stored: unknown, wanted: string | number | null) {
  const blank = (v: unknown) => v === null || v === undefined || v === "";
  if (blank(stored) || blank(wanted)) return blank(stored) && blank(wanted);
  switch (spec.type) {
    case "number":
      return Number(stored) === Number(wanted);
    case "datetime":
      return String(stored).slice(0, 16) === String(wanted).slice(0, 16);
    default:
      return String(stored) === String(wanted);
  }
}
