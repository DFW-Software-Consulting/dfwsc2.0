import { type CalendarInterval, toStripeInterval } from "./stripe-billing";

// Pure mapping of the "New invoice" Nextcloud Form (lib/billing-request-sync.ts): which question is
// which, strict parsing and validation of the answers, and the Chicago-time date rules. No I/O.
//
// Questions are found by their Forms technical name, never by title or position, and radio
// options by their text, so reordering questions or adding extra ones on the form changes nothing.

const BILLING_QUESTION_NAMES = {
  clientCode: "client_code",
  company: "company",
  kind: "kind",
  description: "description",
  amount: "amount_usd",
  interval: "interval",
  payments: "payments",
  startDate: "start_date",
} as const;
const BILLING_MEMO_QUESTION_NAME = "memo";

export type BillingField = keyof typeof BILLING_QUESTION_NAMES;
export type BillingQuestionMap = Record<BillingField, number> & { memo?: number };

export interface BillingFormQuestion {
  id: number;
  /** Forms technical name. */
  name: string;
}

export interface BillingFormAnswer {
  questionId: number;
  text: string;
}

/** The form lacks questions the automation needs. `detail` holds technical names only. */
export class BillingRequestConfigError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string[] = []
  ) {
    super(code);
    this.name = "BillingRequestConfigError";
  }
}

/** A submission that can never succeed; nothing was sent to Stripe. `code` is PII-free. */
export class BillingRequestInvalidError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BillingRequestInvalidError";
  }
}

export function resolveBillingQuestions(questions: BillingFormQuestion[]): BillingQuestionMap {
  const byName = new Map(questions.map((q) => [q.name.trim(), q.id]));
  const missing: string[] = [];
  const map = {} as BillingQuestionMap;
  for (const [field, name] of Object.entries(BILLING_QUESTION_NAMES) as [BillingField, string][]) {
    const id = byName.get(name);
    if (id === undefined) missing.push(name);
    else map[field] = id;
  }
  if (missing.length) throw new BillingRequestConfigError("form_questions_missing", missing);
  const memo = byName.get(BILLING_MEMO_QUESTION_NAME);
  if (memo !== undefined) map.memo = memo;
  return map;
}

// ── Text rules ───────────────────────────────────────────────────────────────

const collapse = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

/**
 * Typo guard for the company: case-insensitive, whitespace collapsed, trailing punctuation
 * ignored, so "Emmut Properties Corp" equals "emmut  properties corp.".
 */
export function normalizeCompany(text: string): string {
  let out = collapse(text).toLowerCase();
  for (;;) {
    const trimmed = out.replace(/[\s.,;:!?]+$/u, "");
    if (trimmed === out) return out;
    out = trimmed;
  }
}

const optionKey = (text: string) => collapse(text).toLowerCase();

const KIND_OPTIONS = {
  "one-off invoice": "one_off",
  "recurring plan": "recurring",
} as const;
export type RequestKind = "one_off" | "recurring";

export type PlanInterval = Extract<CalendarInterval, "week" | "bi_weekly" | "month">;
const INTERVAL_OPTIONS: Record<string, PlanInterval> = {
  weekly: "week",
  "every 2 weeks": "bi_weekly",
  monthly: "month",
};

const MAX_DESCRIPTION_LENGTH = 250;
const MAX_MEMO_LENGTH = 1000;
const MIN_PAYMENTS = 2;
const MAX_PAYMENTS = 104;
const MAX_START_DAYS_AHEAD = 90;
const CLIENT_CODE_MAX_LENGTH = 64;

/** "1500", "1500.00", "12.50": at most six whole digits and, if any, exactly two decimals. */
const AMOUNT_PATTERN = /^\d{1,6}(\.\d{2})?$/;

export function parseAmountCents(text: string): number | null {
  const value = text.trim();
  if (!AMOUNT_PATTERN.test(value)) return null;
  const [dollars, cents = "00"] = value.split(".");
  return Number(dollars) * 100 + Number(cents);
}

/** "$1,500" or "$1,500.50". */
export function formatUsd(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString("en-US");
  const rest = cents % 100;
  return `$${whole}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

const INTERVAL_WORDS: Record<PlanInterval, string> = {
  week: "weekly",
  bi_weekly: "every 2 weeks",
  month: "monthly",
};

/** "$1,500 weekly × 20 from 2026-11-03". */
export function planSummary(input: {
  amountCents: number;
  interval: PlanInterval;
  payments: number;
  startDate: string;
}): string {
  return `${formatUsd(input.amountCents)} ${INTERVAL_WORDS[input.interval]} × ${input.payments} from ${input.startDate}`;
}

// ── Dates (America/Chicago) ──────────────────────────────────────────────────

const BILLING_TIME_ZONE = "America/Chicago";
/** Local hour a plan's first invoice is created. */
const PLAN_START_HOUR = 9;

const chicagoParts = new Intl.DateTimeFormat("en-US", {
  timeZone: BILLING_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function partsOf(ms: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of chicagoParts.formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Today's calendar date in Chicago, YYYY-MM-DD. */
export function chicagoDate(now: Date): string {
  const p = partsOf(now.getTime());
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** A real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The earliest and latest allowed start date when the request was made: tomorrow to +90 days. */
export function startDateBounds(now: Date): { min: string; max: string } {
  const today = chicagoDate(now);
  return { min: addDays(today, 1), max: addDays(today, MAX_START_DAYS_AHEAD) };
}

/** Unix seconds of `hour`:00 Chicago time on the date (DST aware). */
export function chicagoUnix(isoDate: string, hour = PLAN_START_HOUR): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hour, 0, 0);
  const offsetAt = (ms: number) => {
    const p = partsOf(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  let utc = wallAsUtc - offsetAt(wallAsUtc);
  utc = wallAsUtc - offsetAt(utc);
  return Math.floor(utc / 1000);
}

// ── Answers ──────────────────────────────────────────────────────────────────

function textsFor(
  answers: BillingFormAnswer[],
  questions: BillingQuestionMap,
  field: BillingField | "memo"
): string[] {
  const questionId = questions[field];
  if (questionId === undefined) return [];
  return answers
    .filter((a) => a.questionId === questionId)
    .map((a) => a.text.trim())
    .filter(Boolean);
}

/** Single-valued answer; several answers to one question are joined and then fail validation. */
function oneText(
  answers: BillingFormAnswer[],
  questions: BillingQuestionMap,
  field: BillingField | "memo"
): string | undefined {
  const parts = textsFor(answers, questions, field);
  return parts.length ? parts.join(", ") : undefined;
}

/** What can be shown about a request even when it fails validation. Never throws. */
export function peekBillingRequest(
  answers: BillingFormAnswer[],
  questions: BillingQuestionMap
): { clientCode: string | null; kind: RequestKind | null } {
  const code = oneText(answers, questions, "clientCode");
  const kindText = oneText(answers, questions, "kind");
  const kind = kindText
    ? ((KIND_OPTIONS as Record<string, RequestKind>)[optionKey(kindText)] ?? null)
    : null;
  return { clientCode: code ? code.slice(0, CLIENT_CODE_MAX_LENGTH) : null, kind };
}

interface RequestBase {
  clientCode: string;
  company: string;
  description: string;
  amountCents: number;
  memo?: string;
}
export interface OneOffRequest extends RequestBase {
  kind: "one_off";
}
export interface RecurringRequest extends RequestBase {
  kind: "recurring";
  interval: PlanInterval;
  payments: number;
  /** YYYY-MM-DD in America/Chicago. */
  startDate: string;
}
export type BillingRequest = OneOffRequest | RecurringRequest;

/**
 * Reads and validates one submission. `now` is when the request was made (the submission's
 * timestamp), so a request is judged the same on every retry. Throws BillingRequestInvalidError
 * with a PII-free code; the caller must not call Stripe in that case.
 */
export function parseBillingRequest(
  answers: BillingFormAnswer[],
  questions: BillingQuestionMap,
  options: { maxAmountCents: number; now: Date }
): BillingRequest {
  const clientCode = oneText(answers, questions, "clientCode");
  if (!clientCode || clientCode.length > CLIENT_CODE_MAX_LENGTH) {
    throw new BillingRequestInvalidError("invalid_client_code");
  }
  const company = oneText(answers, questions, "company");
  if (!company) throw new BillingRequestInvalidError("missing_company");

  const kindText = oneText(answers, questions, "kind");
  const kind = kindText
    ? (KIND_OPTIONS as Record<string, RequestKind | undefined>)[optionKey(kindText)]
    : undefined;
  if (!kind) throw new BillingRequestInvalidError("invalid_kind");

  const description = oneText(answers, questions, "description");
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new BillingRequestInvalidError("invalid_description");
  }
  const memo = oneText(answers, questions, "memo");
  if (memo && memo.length > MAX_MEMO_LENGTH) throw new BillingRequestInvalidError("invalid_memo");

  const amountText = oneText(answers, questions, "amount");
  const amountCents = amountText === undefined ? null : parseAmountCents(amountText);
  if (amountCents === null || amountCents <= 0) {
    throw new BillingRequestInvalidError("invalid_amount");
  }
  if (amountCents > options.maxAmountCents) {
    throw new BillingRequestInvalidError("amount_too_large");
  }

  const base = {
    clientCode,
    company,
    description,
    amountCents,
    ...(memo ? { memo } : {}),
  };
  if (kind === "one_off") return { kind, ...base };

  const intervalText = oneText(answers, questions, "interval");
  if (!intervalText) throw new BillingRequestInvalidError("missing_interval");
  const interval = INTERVAL_OPTIONS[optionKey(intervalText)];
  if (!interval) throw new BillingRequestInvalidError("invalid_interval");

  const paymentsText = oneText(answers, questions, "payments");
  const payments = paymentsText && /^\d{1,3}$/.test(paymentsText) ? Number(paymentsText) : null;
  if (payments === null || payments < MIN_PAYMENTS || payments > MAX_PAYMENTS) {
    throw new BillingRequestInvalidError("invalid_payments");
  }

  const startDate = oneText(answers, questions, "startDate");
  if (!startDate || !isIsoDate(startDate))
    throw new BillingRequestInvalidError("invalid_start_date");
  const bounds = startDateBounds(options.now);
  if (startDate < bounds.min || startDate > bounds.max) {
    throw new BillingRequestInvalidError("start_date_out_of_range");
  }
  return { kind, ...base, interval, payments, startDate };
}

/** Stripe's recurring price interval and the phase length for the plan. */
export function planStripeShape(interval: PlanInterval, payments: number) {
  // The form's wording and Stripe's intervals meet only here, through toStripeInterval.
  const each = toStripeInterval(interval);
  return {
    recurring: { interval: each.interval, interval_count: each.interval_count },
    // `duration`, not `iterations`: see lib/billing-request-stripe.ts.
    duration: { interval: each.interval, interval_count: each.interval_count * payments },
  };
}
