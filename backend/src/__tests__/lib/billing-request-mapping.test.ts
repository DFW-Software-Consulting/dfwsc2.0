import { describe, expect, it } from "vitest";
import type { billingRequestSubmissions } from "../../db/schema";
import {
  addDays,
  BillingRequestConfigError,
  BillingRequestInvalidError,
  chicagoDate,
  chicagoUnix,
  formatUsd,
  isIsoDate,
  normalizeCompany,
  parseAmountCents,
  parseBillingRequest,
  peekBillingRequest,
  planStripeShape,
  planSummary,
  resolveBillingQuestions,
  startDateBounds,
} from "../../lib/billing-request-mapping";
import {
  billingRequestColumns,
  billingRequestStatus,
  renderBillingRequest,
  stripeInvoiceUrl,
  stripeScheduleUrl,
} from "../../lib/billing-request-render";
import { BR_FORM_QUESTIONS } from "../helpers/fake-nextcloud-billing-requests";

const questions = resolveBillingQuestions(
  Object.entries(BR_FORM_QUESTIONS).map(([name, id]) => ({ id, name }))
);
const answersOf = (values: Record<string, string>) =>
  Object.entries(values).map(([name, text]) => ({
    questionId: BR_FORM_QUESTIONS[name as keyof typeof BR_FORM_QUESTIONS],
    text,
  }));

// Sunday 1 Nov 2026 21:00 CST (DST ended that morning); in UTC it is already 2 Nov.
const NOW = new Date("2026-11-02T03:00:00Z");
const MAX = 2_500_000;
const parse = (values: Record<string, string>, now = NOW, maxAmountCents = MAX) =>
  parseBillingRequest(answersOf(values), questions, { maxAmountCents, now });
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BillingRequestInvalidError);
    return (error as BillingRequestInvalidError).code;
  }
  throw new Error("did not throw");
};

const ONE_OFF = {
  client_code: "CP-004",
  company: "Emmut Properties Corp.",
  kind: "One-off invoice",
  description: "October retainer",
  amount_usd: "1500.00",
};
const RECURRING = {
  ...ONE_OFF,
  kind: "Recurring plan",
  interval: "Weekly",
  payments: "20",
  start_date: "2026-11-03",
};

describe("normalizeCompany", () => {
  it("ignores case, repeated whitespace and trailing punctuation", () => {
    const base = normalizeCompany("Emmut Properties Corp");
    expect(normalizeCompany("Emmut Properties Corp.")).toBe(base);
    expect(normalizeCompany("  emmut   PROPERTIES\tcorp.. ")).toBe(base);
    expect(normalizeCompany("Emmut Properties Corp ,;")).toBe(base);
  });
  it("still tells different companies apart", () => {
    expect(normalizeCompany("Emmut Properties Corp")).not.toBe(
      normalizeCompany("Emmut Properties")
    );
    expect(normalizeCompany("Acme Inc")).not.toBe(normalizeCompany("Acme LLC"));
    expect(normalizeCompany("A.B. Corp")).not.toBe(normalizeCompany("AB Corp"));
  });
});

describe("parseAmountCents", () => {
  it.each([
    ["1500", 150000],
    ["1500.00", 150000],
    ["0.50", 50],
    ["12.34", 1234],
    ["999999.99", 99999999],
    [" 25 ", 2500],
  ])("accepts %s", (text, cents) => {
    expect(parseAmountCents(text)).toBe(cents);
  });
  it.each([
    "",
    "1,500",
    "$15",
    "15.5",
    "1500.0",
    "1500.000",
    "-5",
    "1e3",
    "1234567",
    ".50",
    "15.",
    "abc",
    "1 500",
  ])("refuses %j", (text) => {
    expect(parseAmountCents(text)).toBeNull();
  });
});

describe("formatUsd and planSummary", () => {
  it("formats dollars with separators and drops .00", () => {
    expect(formatUsd(150000)).toBe("$1,500");
    expect(formatUsd(150050)).toBe("$1,500.50");
    expect(formatUsd(5)).toBe("$0.05");
  });
  it("builds the plan text", () => {
    expect(
      planSummary({ amountCents: 150000, interval: "week", payments: 20, startDate: "2026-11-03" })
    ).toBe("$1,500 weekly × 20 from 2026-11-03");
    expect(
      planSummary({
        amountCents: 99900,
        interval: "bi_weekly",
        payments: 6,
        startDate: "2027-01-04",
      })
    ).toBe("$999 every 2 weeks × 6 from 2027-01-04");
    expect(
      planSummary({ amountCents: 250000, interval: "month", payments: 12, startDate: "2027-01-04" })
    ).toBe("$2,500 monthly × 12 from 2027-01-04");
  });
});

describe("parseBillingRequest", () => {
  it("maps a one-off invoice, trimming and ignoring recurring-only answers", () => {
    expect(
      parse({
        ...ONE_OFF,
        client_code: " CP-004 ",
        interval: "Monthly",
        payments: "zzz",
        start_date: "nope",
      })
    ).toEqual({
      kind: "one_off",
      clientCode: "CP-004",
      company: "Emmut Properties Corp.",
      description: "October retainer",
      amountCents: 150000,
    });
  });

  it("keeps the memo when there is one", () => {
    expect(parse({ ...ONE_OFF, memo: " Thanks for the work " })).toMatchObject({
      memo: "Thanks for the work",
    });
  });

  it("maps a recurring plan, matching options by text", () => {
    expect(parse(RECURRING)).toEqual({
      kind: "recurring",
      clientCode: "CP-004",
      company: "Emmut Properties Corp.",
      description: "October retainer",
      amountCents: 150000,
      interval: "week",
      payments: 20,
      startDate: "2026-11-03",
    });
    expect(
      parse({ ...RECURRING, kind: "  recurring   PLAN ", interval: "every 2 weeks" })
    ).toMatchObject({
      kind: "recurring",
      interval: "bi_weekly",
    });
    expect(parse({ ...RECURRING, interval: "MONTHLY" })).toMatchObject({ interval: "month" });
  });

  it("ignores answers to questions it does not know", () => {
    const request = parseBillingRequest(
      [...answersOf(ONE_OFF), { questionId: 999, text: "surprise" }],
      questions,
      { maxAmountCents: MAX, now: NOW }
    );
    expect(request.kind).toBe("one_off");
  });

  it("applies the amount cap per invoice and per recurring payment, inclusive", () => {
    expect(parse({ ...ONE_OFF, amount_usd: "25000.00" })).toMatchObject({ amountCents: 2_500_000 });
    expect(codeOf(() => parse({ ...ONE_OFF, amount_usd: "25000.01" }))).toBe("amount_too_large");
    expect(codeOf(() => parse({ ...RECURRING, amount_usd: "25000.01" }))).toBe("amount_too_large");
    expect(codeOf(() => parse({ ...ONE_OFF, amount_usd: "101" }, NOW, 10_000))).toBe(
      "amount_too_large"
    );
    expect(parse({ ...ONE_OFF, amount_usd: "100" }, NOW, 10_000)).toMatchObject({
      amountCents: 10_000,
    });
  });

  it.each([
    [{ client_code: "" }, "invalid_client_code"],
    [{ client_code: "x".repeat(65) }, "invalid_client_code"],
    [{ company: "  " }, "missing_company"],
    [{ kind: "Both" }, "invalid_kind"],
    [{ kind: "" }, "invalid_kind"],
    [{ description: "" }, "invalid_description"],
    [{ description: "d".repeat(251) }, "invalid_description"],
    [{ memo: "m".repeat(1001) }, "invalid_memo"],
    [{ amount_usd: "" }, "invalid_amount"],
    [{ amount_usd: "0" }, "invalid_amount"],
    [{ amount_usd: "0.00" }, "invalid_amount"],
    [{ amount_usd: "$100" }, "invalid_amount"],
    [{ amount_usd: "1,000" }, "invalid_amount"],
    [{ amount_usd: "10.5" }, "invalid_amount"],
  ])("refuses a one-off with %j as %s", (override, code) => {
    expect(codeOf(() => parse({ ...ONE_OFF, ...override }))).toBe(code);
  });

  it.each([
    [{ interval: "" }, "missing_interval"],
    [{ interval: "Yearly" }, "invalid_interval"],
    [{ payments: "" }, "invalid_payments"],
    [{ payments: "1" }, "invalid_payments"],
    [{ payments: "105" }, "invalid_payments"],
    [{ payments: "0" }, "invalid_payments"],
    [{ payments: "2.5" }, "invalid_payments"],
    [{ payments: "twenty" }, "invalid_payments"],
    [{ payments: "1000" }, "invalid_payments"],
    [{ start_date: "" }, "invalid_start_date"],
    [{ start_date: "11/03/2026" }, "invalid_start_date"],
    [{ start_date: "2026-02-30" }, "invalid_start_date"],
    [{ start_date: "2026-13-01" }, "invalid_start_date"],
  ])("refuses a plan with %j as %s", (override, code) => {
    expect(codeOf(() => parse({ ...RECURRING, ...override }))).toBe(code);
  });

  it("accepts 2 and 104 payments", () => {
    expect(parse({ ...RECURRING, payments: "2" })).toMatchObject({ payments: 2 });
    expect(parse({ ...RECURRING, payments: "104" })).toMatchObject({ payments: 104 });
  });

  it("bounds the start date from tomorrow to +90 days in Chicago time, not UTC", () => {
    // NOW is 2 Nov in UTC but 1 Nov in Chicago: tomorrow is 2 Nov, the last day is 30 Jan 2027.
    expect(startDateBounds(NOW)).toEqual({ min: "2026-11-02", max: "2027-01-30" });
    expect(parse({ ...RECURRING, start_date: "2026-11-02" })).toMatchObject({
      startDate: "2026-11-02",
    });
    expect(parse({ ...RECURRING, start_date: "2027-01-30" })).toMatchObject({
      startDate: "2027-01-30",
    });
    expect(codeOf(() => parse({ ...RECURRING, start_date: "2026-11-01" }))).toBe(
      "start_date_out_of_range"
    );
    expect(codeOf(() => parse({ ...RECURRING, start_date: "2027-01-31" }))).toBe(
      "start_date_out_of_range"
    );
    expect(codeOf(() => parse({ ...RECURRING, start_date: "2020-01-01" }))).toBe(
      "start_date_out_of_range"
    );
  });

  it("moves the bounds once Chicago passes midnight", () => {
    const after = new Date("2026-11-02T06:30:00Z"); // 00:30 CST on 2 Nov
    expect(startDateBounds(after).min).toBe("2026-11-03");
    expect(codeOf(() => parse({ ...RECURRING, start_date: "2026-11-02" }, after))).toBe(
      "start_date_out_of_range"
    );
  });
});

describe("peekBillingRequest", () => {
  it("returns what can be shown for a request that fails validation, and never throws", () => {
    expect(
      peekBillingRequest(answersOf({ client_code: "CP-9", kind: "Recurring plan" }), questions)
    ).toEqual({
      clientCode: "CP-9",
      kind: "recurring",
    });
    expect(peekBillingRequest([], questions)).toEqual({ clientCode: null, kind: null });
    expect(peekBillingRequest(answersOf({ kind: "Other" }), questions).kind).toBeNull();
  });
});

describe("resolveBillingQuestions", () => {
  const all = Object.entries(BR_FORM_QUESTIONS).map(([name, id]) => ({ id, name }));
  it("finds questions by technical name and tolerates extra ones", () => {
    const map = resolveBillingQuestions([
      ...all,
      { id: 1, name: "something_else" },
      { id: 2, name: "" },
    ]);
    expect(map.amount).toBe(BR_FORM_QUESTIONS.amount_usd);
    expect(map.memo).toBe(BR_FORM_QUESTIONS.memo);
  });
  it("treats the memo as optional", () => {
    expect(resolveBillingQuestions(all.filter((q) => q.name !== "memo")).memo).toBeUndefined();
  });
  it("names every missing required question", () => {
    try {
      resolveBillingQuestions(all.filter((q) => !["amount_usd", "payments"].includes(q.name)));
      throw new Error("did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BillingRequestConfigError);
      expect((error as BillingRequestConfigError).detail).toEqual(["amount_usd", "payments"]);
    }
  });
});

describe("Chicago dates", () => {
  it("finds today's date in Chicago", () => {
    expect(chicagoDate(new Date("2026-11-02T03:00:00Z"))).toBe("2026-11-01");
    expect(chicagoDate(new Date("2026-07-01T04:59:00Z"))).toBe("2026-06-30");
    expect(chicagoDate(new Date("2026-07-01T05:00:00Z"))).toBe("2026-07-01");
  });
  it("adds days across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2026-11-01", 90)).toBe("2027-01-30");
  });
  it("checks calendar dates", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-2-9")).toBe(false);
  });
  it("converts 09:00 Chicago to unix seconds, across daylight saving time", () => {
    const utc = (iso: string) => Date.parse(iso) / 1000;
    expect(chicagoUnix("2026-11-03")).toBe(utc("2026-11-03T15:00:00Z")); // CST
    expect(chicagoUnix("2027-07-01")).toBe(utc("2027-07-01T14:00:00Z")); // CDT
    expect(chicagoUnix("2026-11-01")).toBe(utc("2026-11-01T15:00:00Z")); // the day DST ends
    expect(chicagoUnix("2027-03-14")).toBe(utc("2027-03-14T14:00:00Z")); // the day DST starts
  });
});

describe("planStripeShape", () => {
  it("makes the phase a duration of payments x the interval", () => {
    expect(planStripeShape("week", 20)).toEqual({
      recurring: { interval: "week", interval_count: 1 },
      duration: { interval: "week", interval_count: 20 },
    });
    expect(planStripeShape("bi_weekly", 10)).toEqual({
      recurring: { interval: "week", interval_count: 2 },
      duration: { interval: "week", interval_count: 20 },
    });
    expect(planStripeShape("month", 12)).toEqual({
      recurring: { interval: "month", interval_count: 1 },
      duration: { interval: "month", interval_count: 12 },
    });
  });
});

type Row = typeof billingRequestSubmissions.$inferSelect;
const baseRow = (patch: Partial<Row>): Row =>
  ({
    formId: 7,
    submissionId: 1,
    status: "pending",
    attempts: 0,
    nextAttemptAt: new Date(),
    claimedAt: null,
    claimToken: null,
    lastErrorCode: null,
    requestedBy: "alice",
    submittedAt: new Date("2026-11-02T15:05:00Z"),
    clientCode: "CP-004",
    kind: "one_off",
    amountCents: 150000,
    planInterval: null,
    planPayments: null,
    planStartDate: null,
    stripeStartedAt: null,
    stripeProductId: null,
    stripeInvoiceId: null,
    stripeInvoiceItemId: null,
    stripeScheduleId: null,
    invoiceFinalizedAt: null,
    invoiceSentAt: null,
    outcome: null,
    ncRowId: null,
    ncRowHash: null,
    createdAt: new Date(),
    completedAt: null,
    ...patch,
  }) as Row;

describe("renderBillingRequest", () => {
  it("has the columns of the results table, in order", () => {
    expect(billingRequestColumns().map((c) => c.title)).toEqual([
      "Submitted",
      "By",
      "Client Code",
      "Type",
      "Amount",
      "Plan",
      "Status",
      "Error",
      "Stripe",
    ]);
  });

  it("renders every status", () => {
    expect(billingRequestStatus(baseRow({}))).toBe("Processing");
    expect(billingRequestStatus(baseRow({ status: "failed" }))).toBe("Failed");
    expect(billingRequestStatus(baseRow({ status: "completed", outcome: "sent" }))).toBe("Sent");
    expect(billingRequestStatus(baseRow({ status: "completed", outcome: "draft" }))).toBe(
      "Draft created"
    );
    expect(billingRequestStatus(baseRow({ status: "completed", outcome: "scheduled" }))).toBe(
      "Scheduled"
    );
    expect(
      billingRequestStatus(baseRow({ status: "failed", lastErrorCode: "request_expired" }))
    ).toBe("Expired");
    const finalized = { invoiceFinalizedAt: new Date(), stripeInvoiceId: "in_1" };
    expect(billingRequestStatus(baseRow({ status: "failed", ...finalized }))).toBe(
      "Finalized, not sent"
    );
    // Still being retried: not final yet.
    expect(billingRequestStatus(baseRow({ status: "pending", ...finalized }))).toBe("Processing");
    // Sent but the table write is what failed: not the "not sent" state.
    expect(
      billingRequestStatus(baseRow({ status: "failed", ...finalized, invoiceSentAt: new Date() }))
    ).toBe("Failed");
  });

  it("renders a sent invoice with its dashboard link and no PII", () => {
    const values = renderBillingRequest(
      baseRow({ status: "completed", outcome: "sent", stripeInvoiceId: "in_123" })
    );
    expect(values).toEqual({
      submitted: "2026-11-02 15:05",
      by: "alice",
      clientCode: "CP-004",
      type: "One-off invoice",
      amount: 1500,
      plan: "",
      status: "Sent",
      error: "",
      stripe: stripeInvoiceUrl("in_123"),
    });
    expect(stripeInvoiceUrl("in_123")).toMatch(
      /^https:\/\/dashboard\.stripe\.com\/(test\/)?invoices\/in_123$/
    );
  });

  it("renders a plan with its summary and schedule link", () => {
    const values = renderBillingRequest(
      baseRow({
        status: "completed",
        outcome: "scheduled",
        kind: "recurring",
        planInterval: "week",
        planPayments: 20,
        planStartDate: "2026-11-03",
        stripeScheduleId: "sub_sched_9",
      })
    );
    expect(values).toMatchObject({
      type: "Recurring plan",
      plan: "$1,500 weekly × 20 from 2026-11-03",
      status: "Scheduled",
      stripe: stripeScheduleUrl("sub_sched_9"),
    });
  });

  it("renders a refused request with the code only", () => {
    expect(
      renderBillingRequest(
        baseRow({
          status: "failed",
          lastErrorCode: "company_mismatch",
          kind: null,
          amountCents: null,
        })
      )
    ).toMatchObject({
      status: "Failed",
      error: "company_mismatch",
      type: "",
      amount: null,
      stripe: "",
    });
  });

  it("keeps the link of a request that failed after creating something", () => {
    expect(
      renderBillingRequest(
        baseRow({ status: "failed", stripeInvoiceId: "in_9", lastErrorCode: "stripe.send:400" })
      )
    ).toMatchObject({ stripe: stripeInvoiceUrl("in_9"), error: "stripe.send:400" });
  });
});
