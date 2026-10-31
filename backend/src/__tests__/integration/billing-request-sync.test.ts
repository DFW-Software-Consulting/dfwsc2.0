import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeInvoicing } = await import("../helpers/fake-stripe-invoicing");
  return { stripe: fakeInvoicing.stripe };
});

import { db } from "../../db/client";
import {
  billingCustomers,
  billingRequestSubmissions,
  billingRequestSyncState,
  billingSnapshots,
  portalMirrorRows,
  portalMirrorState,
} from "../../db/schema";
import { addDays, chicagoDate, chicagoUnix } from "../../lib/billing-request-mapping";
import { stripeInvoiceUrl, stripeScheduleUrl } from "../../lib/billing-request-render";
import {
  loadBillingRequestsConfig,
  resetBillingRequestsStateForTests,
  runBillingRequestsCycle,
  startBillingRequests,
} from "../../lib/billing-request-sync";
import { resetCircuitBreakersForTests, withStripeCircuit } from "../../lib/circuit-breakers";
import { BILLING_REQUESTS_MAX_ATTEMPTS } from "../../lib/constants";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import {
  type BillingAnswers,
  BR_FORM_ID,
  BR_FORM_QUESTIONS,
  billingRequestEnv,
  FakeBillingRequestNextcloud,
} from "../helpers/fake-nextcloud-billing-requests";
import {
  ALLOWED_CALLS,
  apiError,
  connectionError,
  fakeInvoicing as stripe,
} from "../helpers/fake-stripe-invoicing";

type Logger = Parameters<typeof runBillingRequestsCycle>[0]["logger"];

const CUSTOMER = "cus_emmut";
let fake: FakeBillingRequestNextcloud;
let lines: { level: string; text: string }[];

function logger(): Logger {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, text: JSON.stringify(args) });
    };
  return { info: rec("info"), warn: rec("warn"), error: rec("error") } as unknown as Logger;
}

const on = billingRequestEnv();
const cycle = (env: NodeJS.ProcessEnv = on) =>
  runBillingRequestsCycle({ logger: logger(), env, minGapMs: 0 });

const startDate = (days = 3) => addDays(chicagoDate(new Date()), days);
const ONE_OFF: BillingAnswers = {
  client_code: "CP-004",
  company: "Emmut Properties Corp",
  kind: "One-off invoice",
  description: "October retainer",
  amount_usd: "1500.00",
};
const recurring = (extra: BillingAnswers = {}): BillingAnswers => ({
  ...ONE_OFF,
  kind: "Recurring plan",
  interval: "Weekly",
  payments: "20",
  start_date: startDate(),
  ...extra,
});

async function sub(submissionId: number) {
  const [row] = await db
    .select()
    .from(billingRequestSubmissions)
    .where(eq(billingRequestSubmissions.submissionId, submissionId));
  return row;
}
const makeDue = (submissionId: number) =>
  db
    .update(billingRequestSubmissions)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(eq(billingRequestSubmissions.submissionId, submissionId));

const resultsTable = () => fake.tables.find((t) => t.title === "Billing Requests");
const resultRows = () => fake.rowsOf((resultsTable() as { id: number }).id);
const cell = (row: ReturnType<typeof resultRows>[number], title: string) => fake.cell(row, title);

/** Records the baseline (no submissions yet), then adds the submission and runs a cycle. */
async function submit(id: number, answers: BillingAnswers, userId: string | null = "alice") {
  fake.addSubmission(id, answers, { userId });
  return cycle();
}

beforeEach(async () => {
  await db.delete(billingRequestSubmissions);
  await db.delete(billingRequestSyncState);
  await db.delete(billingSnapshots);
  await db.delete(billingCustomers);
  await db.delete(portalMirrorRows);
  await db.delete(portalMirrorState);
  await db.insert(billingCustomers).values([
    {
      clientCode: "CP-004",
      company: "Emmut Properties Corp.",
      email: "ap@emmut.example",
      stripeCustomerId: CUSTOMER,
      source: "created",
    },
    {
      clientCode: "CP-005",
      company: "Other Co",
      email: "ap@other.example",
      stripeCustomerId: "cus_other",
      source: "created",
    },
  ]);
  stripe.reset();
  resetNextcloudBreakerForTests();
  resetCircuitBreakersForTests();
  resetBillingRequestsStateForTests();
  lines = [];
  fake = new FakeBillingRequestNextcloud();
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  expect((await cycle()).status).toBe("ok"); // baseline, empty form
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetNextcloudBreakerForTests();
  resetCircuitBreakersForTests();
  resetBillingRequestsStateForTests();
});

const KEY = (id: number, step: string) => ({
  idempotencyKey: `ncbill-${BR_FORM_ID}-${id}-${step}`,
});

describe("one-off invoice", () => {
  it("creates, finalizes and sends the invoice with the exact parameters and keys", async () => {
    const result = await submit(11, { ...ONE_OFF, memo: "Thank you" });
    expect(result).toMatchObject({ status: "ok", discovered: 1, completed: 1, failed: 0 });

    const meta = { nc_form: String(BR_FORM_ID), nc_submission: "11", client_code: "CP-004" };
    expect(stripe.writes().map((c) => c.call)).toEqual([
      "invoices.create",
      "invoiceItems.create",
      "invoices.finalizeInvoice",
      "invoices.sendInvoice",
    ]);
    expect(stripe.writes()[0]).toMatchObject({
      params: {
        customer: CUSTOMER,
        currency: "usd",
        collection_method: "send_invoice",
        days_until_due: 7,
        pending_invoice_items_behavior: "exclude",
        auto_advance: false,
        description: "Thank you",
        metadata: meta,
      },
      options: KEY(11, "invoice"),
    });
    const invoiceId = (await sub(11)).stripeInvoiceId as string;
    expect(stripe.writes()[1]).toMatchObject({
      params: {
        invoice: invoiceId,
        customer: CUSTOMER,
        amount: 150000,
        currency: "usd",
        description: "October retainer",
        metadata: meta,
      },
      options: KEY(11, "item"),
    });
    expect(stripe.writes()[2]).toMatchObject({
      params: { id: invoiceId },
      options: KEY(11, "finalize"),
    });
    expect(stripe.writes()[3]).toMatchObject({
      params: { id: invoiceId },
      options: KEY(11, "send"),
    });

    expect(await sub(11)).toMatchObject({
      status: "completed",
      outcome: "sent",
      lastErrorCode: null,
      requestedBy: "alice",
      clientCode: "CP-004",
      kind: "one_off",
      amountCents: 150000,
      stripeInvoiceItemId: expect.stringMatching(/^ii_/),
    });
  });

  it("omits the invoice description when there is no memo", async () => {
    await submit(12, ONE_OFF);
    expect(stripe.writes()[0].params).not.toHaveProperty("description");
  });

  it("only creates a draft when BILLING_AUTO_SEND is off", async () => {
    await submit(13, ONE_OFF).catch(() => undefined);
    stripe.reset();
    const off = billingRequestEnv({ BILLING_AUTO_SEND: "false" });
    fake.addSubmission(14, ONE_OFF);
    expect(await cycle(off)).toMatchObject({ completed: 1 });
    expect(stripe.writes().map((c) => c.call)).toEqual(["invoices.create", "invoiceItems.create"]);
    expect(await sub(14)).toMatchObject({
      status: "completed",
      outcome: "draft",
      invoiceSentAt: null,
    });
    const [row] = resultRows().filter((r) => cell(r, "Status") === "Draft created");
    expect(row).toBeDefined();
  });

  it("honours BILLING_DEFAULT_DAYS_UNTIL_DUE", async () => {
    fake.addSubmission(15, ONE_OFF);
    await cycle(billingRequestEnv({ BILLING_DEFAULT_DAYS_UNTIL_DUE: "30" }));
    expect(stripe.writes()[0].params).toMatchObject({ days_until_due: 30 });
  });

  it("accepts a company that differs only in case, spacing or trailing punctuation, and a lower-case code", async () => {
    await submit(16, { ...ONE_OFF, client_code: "cp-004", company: "  EMMUT  properties corp.. " });
    expect(await sub(16)).toMatchObject({ status: "completed", clientCode: "CP-004" });
  });

  it("tolerates unknown extra questions on the form", async () => {
    fake.formQuestions.push({ id: 900, name: "favourite_colour" });
    fake.addSubmission(17, ONE_OFF, { extra: [[900, "green"]] });
    await cycle();
    expect(await sub(17)).toMatchObject({ status: "completed" });
  });

  it("writes the result row and marks the client's billing snapshot dirty", async () => {
    await db
      .insert(billingSnapshots)
      .values({ clientCode: "CP-004", stripeCustomerId: CUSTOMER, refreshedAt: new Date() });
    await submit(18, ONE_OFF);
    const [snap] = await db
      .select()
      .from(billingSnapshots)
      .where(eq(billingSnapshots.clientCode, "CP-004"));
    expect(snap.dirtyAt).not.toBeNull();

    const rows = resultRows();
    expect(rows).toHaveLength(1);
    const invoiceId = (await sub(18)).stripeInvoiceId as string;
    expect(
      Object.fromEntries(
        ["By", "Client Code", "Type", "Amount", "Plan", "Status", "Error", "Stripe"].map((t) => [
          t,
          cell(rows[0], t),
        ])
      )
    ).toEqual({
      By: "alice",
      "Client Code": "CP-004",
      Type: "One-off invoice",
      Amount: 1500,
      Plan: "",
      Status: "Sent",
      Error: "",
      Stripe: stripeInvoiceUrl(invoiceId),
    });
    expect(cell(rows[0], "Submitted")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("recurring plan", () => {
  it("creates one product and a Subscription Schedule with a duration phase", async () => {
    const date = startDate(5);
    const result = await submit(21, recurring({ start_date: date, memo: "Retainer for Q4" }));
    expect(result).toMatchObject({ completed: 1 });

    const meta = { nc_form: String(BR_FORM_ID), nc_submission: "21", client_code: "CP-004" };
    expect(stripe.writes().map((c) => c.call)).toEqual([
      "products.create",
      "subscriptionSchedules.create",
    ]);
    expect(stripe.writes()[0]).toMatchObject({
      params: { name: "October retainer", metadata: meta },
      options: KEY(21, "product"),
    });
    const productId = (await sub(21)).stripeProductId as string;
    expect(stripe.writes()[1].params).toEqual({
      customer: CUSTOMER,
      start_date: chicagoUnix(date),
      end_behavior: "cancel",
      default_settings: {
        collection_method: "send_invoice",
        invoice_settings: { days_until_due: 7 },
      },
      phases: [
        {
          items: [
            {
              price_data: {
                currency: "usd",
                product: productId,
                unit_amount: 150000,
                recurring: { interval: "week", interval_count: 1 },
              },
              quantity: 1,
            },
          ],
          duration: { interval: "week", interval_count: 20 },
          description: "Retainer for Q4",
          metadata: meta,
        },
      ],
      metadata: meta,
    });
    expect(stripe.writes()[1].params?.phases[0]).not.toHaveProperty("iterations");
    expect(stripe.writes()[1].options).toEqual(KEY(21, "schedule"));

    const scheduleId = (await sub(21)).stripeScheduleId as string;
    expect(await sub(21)).toMatchObject({
      status: "completed",
      outcome: "scheduled",
      kind: "recurring",
      planInterval: "week",
      planPayments: 20,
      planStartDate: date,
    });
    const [row] = resultRows();
    expect(cell(row, "Status")).toBe("Scheduled");
    expect(cell(row, "Type")).toBe("Recurring plan");
    expect(cell(row, "Plan")).toBe(`$1,500 weekly × 20 from ${date}`);
    expect(cell(row, "Stripe")).toBe(stripeScheduleUrl(scheduleId));
    // Never an invoice: the schedule creates them.
    expect(stripe.callsTo("invoices.create")).toHaveLength(0);
  });

  it.each([
    [
      "Every 2 weeks",
      "10",
      { interval: "week", interval_count: 2 },
      { interval: "week", interval_count: 20 },
    ],
    [
      "Monthly",
      "12",
      { interval: "month", interval_count: 1 },
      { interval: "month", interval_count: 12 },
    ],
    [
      "Weekly",
      "2",
      { interval: "week", interval_count: 1 },
      { interval: "week", interval_count: 2 },
    ],
    [
      "Monthly",
      "104",
      { interval: "month", interval_count: 1 },
      { interval: "month", interval_count: 104 },
    ],
  ])("maps %s x %s to the phase duration", async (interval, payments, recurringShape, duration) => {
    await submit(22, recurring({ interval, payments }));
    const phase = stripe.callsTo("subscriptionSchedules.create")[0].params?.phases[0];
    expect(phase.duration).toEqual(duration);
    expect(phase.items[0].price_data.recurring).toEqual(recurringShape);
  });

  it("is not affected by BILLING_AUTO_SEND", async () => {
    fake.addSubmission(23, recurring());
    await cycle(billingRequestEnv({ BILLING_AUTO_SEND: "false" }));
    expect((await sub(23)).outcome).toBe("scheduled");
  });
});

describe("idempotency keys and resuming", () => {
  it("puts ncbill-{form}-{submission}-{step} on every Stripe write", async () => {
    fake.addSubmission(31, ONE_OFF);
    fake.addSubmission(32, recurring());
    await cycle();
    const writes = stripe.calls.filter((c) =>
      /\.(create|finalizeInvoice|sendInvoice)$/.test(c.call)
    );
    expect(writes).toHaveLength(6);
    for (const call of writes) {
      expect(call.options?.idempotencyKey).toMatch(
        new RegExp(`^ncbill-${BR_FORM_ID}-(31|32)-(invoice|item|finalize|send|product|schedule)$`)
      );
    }
    expect(writes.map((c) => c.options?.idempotencyKey)).toEqual([
      "ncbill-7-31-invoice",
      "ncbill-7-31-item",
      "ncbill-7-31-finalize",
      "ncbill-7-31-send",
      "ncbill-7-32-product",
      "ncbill-7-32-schedule",
    ]);
  });

  it("resumes after the invoice item failed: the invoice is not created twice", async () => {
    stripe.fail("invoiceItems.create", apiError(503));
    await submit(41, ONE_OFF);
    let row = await sub(41);
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorCode: "stripe.item:503",
      stripeInvoiceId: expect.stringMatching(/^in_/),
      stripeInvoiceItemId: null,
    });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(resultRows().map((r) => cell(r, "Status"))).toEqual(["Processing"]);
    expect(cell(resultRows()[0], "Error")).toBe("stripe.item:503");

    await makeDue(41);
    expect(await cycle()).toMatchObject({ completed: 1 });
    row = await sub(41);
    expect(row).toMatchObject({ status: "completed", outcome: "sent", lastErrorCode: null });
    expect(stripe.created("invoices.create")).toHaveLength(1);
    expect(stripe.created("invoiceItems.create")).toHaveLength(1);
    expect(stripe.created("invoices.finalizeInvoice")).toHaveLength(1);
    expect(stripe.created("invoices.sendInvoice")).toHaveLength(1);
    // The same row of the results table was updated, not a second one added.
    expect(resultRows()).toHaveLength(1);
    expect(cell(resultRows()[0], "Status")).toBe("Sent");
  });

  it("does not finalize twice when only the send failed", async () => {
    stripe.fail("invoices.sendInvoice", apiError(500));
    await submit(42, ONE_OFF);
    expect(await sub(42)).toMatchObject({ status: "pending", lastErrorCode: "stripe.send:500" });
    expect((await sub(42)).invoiceFinalizedAt).not.toBeNull();
    await makeDue(42);
    await cycle();
    expect(await sub(42)).toMatchObject({ status: "completed", outcome: "sent" });
    expect(stripe.callsTo("invoices.finalizeInvoice")).toHaveLength(1);
    expect(stripe.callsTo("invoices.sendInvoice")).toHaveLength(2);
  });

  it("survives a lost response: the same key replays the object instead of creating another", async () => {
    stripe.fail("invoiceItems.create", connectionError(), 1, true);
    await submit(43, ONE_OFF);
    expect((await sub(43)).stripeInvoiceItemId).toBeNull();
    await makeDue(43);
    await cycle();
    expect(await sub(43)).toMatchObject({ status: "completed", outcome: "sent" });
    const items = stripe.callsTo("invoiceItems.create");
    // The retry found the item by its metadata and adopted it: nothing was created a second time.
    expect(items).toHaveLength(1);
    expect(stripe.callsTo("invoiceItems.list")).toHaveLength(1);
    expect((await sub(43)).stripeInvoiceItemId).toMatch(/^ii_/);
  });

  it("resumes a plan after the schedule failed: one product only", async () => {
    stripe.fail("subscriptionSchedules.create", apiError(502));
    await submit(44, recurring());
    expect(await sub(44)).toMatchObject({
      status: "pending",
      stripeProductId: expect.stringMatching(/^prod_/),
      stripeScheduleId: null,
    });
    await makeDue(44);
    await cycle();
    expect(await sub(44)).toMatchObject({ status: "completed", outcome: "scheduled" });
    expect(stripe.created("products.create")).toHaveLength(1);
    expect(stripe.created("subscriptionSchedules.create")).toHaveLength(1);
  });

  it("does not call Stripe again for a request that is already done", async () => {
    await submit(45, ONE_OFF);
    const before = stripe.calls.length;
    await makeDue(45);
    await db
      .update(billingRequestSubmissions)
      .set({ status: "pending" })
      .where(eq(billingRequestSubmissions.submissionId, 45));
    await cycle();
    expect(stripe.calls.length).toBe(before);
    expect((await sub(45)).status).toBe("completed");
  });

  describe("past Stripe's 24 hour key window", () => {
    const old = (id: number, patch: Partial<typeof billingRequestSubmissions.$inferInsert> = {}) =>
      db
        .update(billingRequestSubmissions)
        .set({ stripeStartedAt: new Date(Date.now() - 21 * 3600 * 1000), ...patch })
        .where(eq(billingRequestSubmissions.submissionId, id));

    it("adopts an invoice found by metadata instead of creating one", async () => {
      stripe.fail("invoiceItems.create", apiError(503));
      await submit(51, ONE_OFF);
      const first = await sub(51);
      // Pretend the invoice id was never saved and the key has expired.
      await old(51, { stripeInvoiceId: null, stripeInvoiceItemId: null });
      stripe.reset();
      stripe.searchResults["invoices.list"] = [
        {
          id: first.stripeInvoiceId,
          metadata: { nc_form: String(BR_FORM_ID), nc_submission: "51" },
        },
        { id: "in_foreign", metadata: { nc_form: String(BR_FORM_ID), nc_submission: "999" } },
      ];
      await makeDue(51);
      await cycle();
      expect(await sub(51)).toMatchObject({
        status: "completed",
        stripeInvoiceId: first.stripeInvoiceId,
      });
      expect(stripe.callsTo("invoices.create")).toHaveLength(0);
      const list = stripe.callsTo("invoices.list")[0];
      expect(list.params).toMatchObject({ customer: CUSTOMER, limit: 100 });
      expect(list.params?.created.gte).toBeGreaterThan(0);
    });

    it("adopts an invoice item and skips a finalize that already happened", async () => {
      stripe.fail("invoices.sendInvoice", apiError(500));
      await submit(52, ONE_OFF);
      const first = await sub(52);
      await old(52, { stripeInvoiceItemId: null, invoiceFinalizedAt: null });
      stripe.reset();
      stripe.invoiceStatus.set(first.stripeInvoiceId as string, "open");
      stripe.searchResults["invoiceItems.list"] = [
        { id: "ii_existing", metadata: { nc_form: String(BR_FORM_ID), nc_submission: "52" } },
        { id: "ii_foreign", metadata: { nc_form: "9", nc_submission: "52" } },
      ];
      await makeDue(52);
      await cycle();
      expect(await sub(52)).toMatchObject({
        status: "completed",
        stripeInvoiceItemId: "ii_existing",
      });
      expect(stripe.callsTo("invoiceItems.create")).toHaveLength(0);
      expect(stripe.callsTo("invoices.finalizeInvoice")).toHaveLength(0);
      expect(stripe.callsTo("invoices.sendInvoice")).toHaveLength(1);
    });

    it("adopts a schedule found by metadata, without making a product", async () => {
      stripe.fail("subscriptionSchedules.create", apiError(502));
      await submit(53, recurring());
      await old(53, { stripeProductId: null, stripeScheduleId: null });
      stripe.reset();
      stripe.searchResults["subscriptionSchedules.list"] = [
        { id: "sub_sched_other", metadata: { nc_form: String(BR_FORM_ID), nc_submission: "999" } },
        {
          id: "sub_sched_existing",
          metadata: { nc_form: String(BR_FORM_ID), nc_submission: "53" },
        },
      ];
      await makeDue(53);
      await cycle();
      expect(await sub(53)).toMatchObject({
        status: "completed",
        outcome: "scheduled",
        stripeScheduleId: "sub_sched_existing",
      });
      expect(stripe.calls.filter((c) => c.call.endsWith(".create"))).toHaveLength(0);
    });

    it("adopts a product found by metadata when there is no schedule yet", async () => {
      stripe.fail("subscriptionSchedules.create", apiError(502));
      await submit(55, recurring());
      await old(55, { stripeProductId: null, stripeScheduleId: null });
      stripe.reset();
      stripe.searchResults["products.search"] = [
        { id: "prod_existing", metadata: { nc_form: String(BR_FORM_ID), nc_submission: "55" } },
      ];
      await makeDue(55);
      await cycle();
      expect(await sub(55)).toMatchObject({
        status: "completed",
        stripeProductId: "prod_existing",
        stripeScheduleId: expect.stringMatching(/^sub_sched_/),
      });
      expect(stripe.callsTo("products.create")).toHaveLength(0);
    });

    it("creates normally when nothing is found", async () => {
      stripe.fail("invoices.create", apiError(503));
      await submit(54, ONE_OFF);
      await old(54);
      await makeDue(54);
      await cycle();
      expect(await sub(54)).toMatchObject({ status: "completed" });
      expect(stripe.callsTo("invoices.list")).toHaveLength(1);
      expect(stripe.created("invoices.create")).toHaveLength(1);
    });
  });
});

describe("refused requests never reach Stripe", () => {
  const refusals: [string, BillingAnswers, string][] = [
    ["an unknown client code", { ...ONE_OFF, client_code: "CP-999" }, "unknown_client_code"],
    ["a company mismatch", { ...ONE_OFF, company: "Emmut Properties" }, "company_mismatch"],
    ["another client's company", { ...ONE_OFF, company: "Other Co" }, "company_mismatch"],
    ["an amount above the cap", { ...ONE_OFF, amount_usd: "25000.01" }, "amount_too_large"],
    ["a plan payment above the cap", recurring({ amount_usd: "30000" }), "amount_too_large"],
    ["a malformed amount", { ...ONE_OFF, amount_usd: "1,500" }, "invalid_amount"],
    ["too few payments", recurring({ payments: "1" }), "invalid_payments"],
    ["too many payments", recurring({ payments: "105" }), "invalid_payments"],
    ["a start date today", recurring({ start_date: startDate(0) }), "start_date_out_of_range"],
    [
      "a start date in the past",
      recurring({ start_date: "2020-01-01" }),
      "start_date_out_of_range",
    ],
    [
      "a start date too far ahead",
      recurring({ start_date: startDate(91) }),
      "start_date_out_of_range",
    ],
    ["no interval", recurring({ interval: undefined }), "missing_interval"],
    ["an unknown kind", { ...ONE_OFF, kind: "Refund" }, "invalid_kind"],
  ];

  it.each(
    refusals
  )("fails %s without a Stripe call and without retrying", async (_name, answers, code) => {
    const result = await submit(61, answers);
    expect(result).toMatchObject({ completed: 0, failed: 1, retried: 0 });
    expect(stripe.calls).toHaveLength(0);
    expect(await sub(61)).toMatchObject({ status: "failed", lastErrorCode: code, attempts: 1 });
    const [row] = resultRows();
    expect(cell(row, "Status")).toBe("Failed");
    expect(cell(row, "Error")).toBe(code);
    expect(cell(row, "Stripe")).toBe("");
    // Not picked up again.
    await makeDue(61);
    expect(await cycle()).toMatchObject({ completed: 0, failed: 0, retried: 0 });
    expect(stripe.calls).toHaveLength(0);
  });

  it("allows the largest amount", async () => {
    await submit(62, { ...ONE_OFF, amount_usd: "25000.00" });
    expect(await sub(62)).toMatchObject({ status: "completed", amountCents: 2_500_000 });
  });

  it("honours BILLING_MAX_AMOUNT_CENTS", async () => {
    fake.addSubmission(63, { ...ONE_OFF, amount_usd: "501" });
    await cycle(billingRequestEnv({ BILLING_MAX_AMOUNT_CENTS: "50000" }));
    expect(await sub(63)).toMatchObject({ status: "failed", lastErrorCode: "amount_too_large" });
    expect(stripe.calls).toHaveLength(0);
  });

  it("fails a submission that was deleted before it was read", async () => {
    await db.insert(billingRequestSubmissions).values({ formId: BR_FORM_ID, submissionId: 64 });
    await cycle();
    expect(await sub(64)).toMatchObject({
      status: "failed",
      lastErrorCode: "submission_not_found",
    });
    expect(stripe.calls).toHaveLength(0);
  });
});

describe("authorization", () => {
  it.each([
    ["an anonymous submitter", null],
    ["an anonymous form user id", "anon-user-0123456789"],
    ["a user who is not in an allowed group", "mallory"],
    ["a user Nextcloud does not know", "ghost"],
  ])("refuses %s with no Stripe call", async (_name, userId) => {
    const result = await submit(71, ONE_OFF, userId);
    expect(result).toMatchObject({ failed: 1, completed: 0 });
    expect(stripe.calls).toHaveLength(0);
    expect(await sub(71)).toMatchObject({ status: "failed", lastErrorCode: "unauthorized" });
    const [row] = resultRows();
    expect(cell(row, "Status")).toBe("Failed");
    expect(cell(row, "Error")).toBe("unauthorized");
  });

  it("asks Nextcloud for the submitter's groups", async () => {
    await submit(72, ONE_OFF, "alice");
    expect(fake.formCalls.some((c) => c.path === "/ocs/v2.php/cloud/users/alice/groups")).toBe(
      true
    );
  });

  it("accepts a member of any allowed group", async () => {
    await submit(73, ONE_OFF, "alice"); // dfwsc-admins
    await submit(74, ONE_OFF, "mia"); // managers
    expect((await sub(73)).status).toBe("completed");
    expect((await sub(74)).status).toBe("completed");
  });

  it("uses BILLING_REQUESTS_ALLOWED_GROUPS", async () => {
    fake.addSubmission(75, ONE_OFF, { userId: "mallory" });
    fake.addSubmission(76, ONE_OFF, { userId: "alice" });
    await cycle(billingRequestEnv({ BILLING_REQUESTS_ALLOWED_GROUPS: "staff" }));
    expect(await sub(75)).toMatchObject({ status: "completed" });
    expect(await sub(76)).toMatchObject({ status: "failed", lastErrorCode: "unauthorized" });
  });

  it("retries when the groups lookup is unavailable instead of refusing", async () => {
    fake.failForms(/\/users\/alice\/groups$/, 503);
    await submit(77, ONE_OFF);
    expect(await sub(77)).toMatchObject({ status: "pending", lastErrorCode: "users.groups:503" });
    expect(stripe.calls).toHaveLength(0);
    await makeDue(77);
    await cycle();
    expect((await sub(77)).status).toBe("completed");
  });
});

describe("retryable and permanent Stripe errors", () => {
  it.each([
    ["rate limited (429)", apiError(429), "stripe.invoice:429"],
    ["a server error (500)", apiError(500), "stripe.invoice:500"],
    ["a bad gateway (502)", apiError(502), "stripe.invoice:502"],
    ["a connection error", connectionError(), "stripe.invoice:connection"],
    ["a concurrent idempotent request (409)", apiError(409), "stripe.invoice:409"],
  ])("retries with backoff on %s", async (_name, error, code) => {
    stripe.fail("invoices.create", error, 99);
    const result = await submit(81, ONE_OFF);
    expect(result).toMatchObject({ retried: 1, failed: 0, completed: 0 });
    const row = await sub(81);
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: code });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Not retried before it is due.
    expect(await cycle()).toMatchObject({ retried: 0 });
    expect(stripe.callsTo("invoices.create")).toHaveLength(1);
  });

  it("backs off longer after each failure", async () => {
    stripe.fail("invoices.create", apiError(503), 99);
    await submit(82, ONE_OFF);
    const first = (await sub(82)).nextAttemptAt.getTime() - Date.now();
    await makeDue(82);
    await cycle();
    const second = (await sub(82)).nextAttemptAt.getTime() - Date.now();
    expect(second).toBeGreaterThan(first * 1.5);
  });

  it.each([
    ["an invalid request (400)", apiError(400), "stripe.invoice:400"],
    ["a missing resource (404)", apiError(404), "stripe.invoice:404"],
    ["a rejected key (401)", apiError(401), "stripe.invoice:401"],
  ])("fails for good on %s", async (_name, error, code) => {
    stripe.fail("invoices.create", error, 99);
    const result = await submit(83, ONE_OFF);
    expect(result).toMatchObject({ failed: 1, retried: 0 });
    expect(await sub(83)).toMatchObject({ status: "failed", lastErrorCode: code });
    await makeDue(83);
    await cycle();
    expect(stripe.callsTo("invoices.create")).toHaveLength(1);
    expect(cell(resultRows()[0], "Status")).toBe("Failed");
  });

  it("keeps the invoice id and link of a request that failed after creating it", async () => {
    stripe.fail("invoices.sendInvoice", apiError(400));
    await submit(84, ONE_OFF);
    const row = await sub(84);
    expect(row).toMatchObject({ status: "failed", lastErrorCode: "stripe.send:400" });
    expect(cell(resultRows()[0], "Stripe")).toBe(stripeInvoiceUrl(row.stripeInvoiceId as string));
  });

  it("gives up after the maximum number of attempts", async () => {
    stripe.fail("invoices.create", apiError(503), 999);
    await submit(85, ONE_OFF);
    for (let i = 1; i < BILLING_REQUESTS_MAX_ATTEMPTS; i++) {
      expect((await sub(85)).status).toBe("pending");
      resetCircuitBreakersForTests(); // five failures in a row would open the real breaker
      await makeDue(85);
      await cycle();
    }
    expect(await sub(85)).toMatchObject({
      status: "failed",
      attempts: BILLING_REQUESTS_MAX_ATTEMPTS,
      lastErrorCode: "stripe.invoice:503",
    });
  });

  it("stops the cycle and keeps the rest waiting when the Stripe breaker is open", async () => {
    for (let i = 0; i < 5; i++) {
      await withStripeCircuit(() => Promise.reject(connectionError())).catch(() => undefined);
    }
    fake.addSubmission(86, ONE_OFF);
    fake.addSubmission(87, ONE_OFF);
    const result = await cycle();
    expect(result).toMatchObject({ status: "stripe_unavailable", retried: 1 });
    expect(stripe.calls).toHaveLength(0);
    expect(await sub(86)).toMatchObject({
      status: "pending",
      lastErrorCode: "stripe.circuit_open",
    });
    expect(await sub(87)).toMatchObject({ status: "pending", attempts: 0, claimedAt: null });
  });

  it("retries only the result row when Stripe is done, without calling Stripe again", async () => {
    fake.addSubmission(88, ONE_OFF);
    fake.fail("POST", /\/tables\/\d+\/rows$/, 503, 1);
    await cycle();
    expect(await sub(88)).toMatchObject({
      status: "pending",
      lastErrorCode: "mirror.create_row:503",
      outcome: "sent",
    });
    // The failure itself is recorded in the table (the fault was only for the first write).
    expect(resultRows().map((r) => [cell(r, "Status"), cell(r, "Error")])).toEqual([
      ["Processing", "mirror.create_row:503"],
    ]);
    const calls = stripe.calls.length;
    await makeDue(88);
    await cycle();
    expect(stripe.calls.length).toBe(calls);
    expect(await sub(88)).toMatchObject({
      status: "completed",
      outcome: "sent",
      lastErrorCode: null,
    });
    expect(resultRows().map((r) => cell(r, "Status"))).toEqual(["Sent"]);
  });

  it("does not report a sent invoice as failed when the result row never gets written", async () => {
    fake.addSubmission(89, ONE_OFF);
    fake.fail("POST", /\/tables\/\d+\/rows$/, 503, 999);
    await cycle();
    for (let i = 1; i < BILLING_REQUESTS_MAX_ATTEMPTS; i++) {
      resetNextcloudBreakerForTests();
      await makeDue(89);
      await cycle();
    }
    expect(await sub(89)).toMatchObject({
      status: "completed",
      outcome: "sent",
      lastErrorCode: "mirror.create_row:503",
    });
    expect(stripe.created("invoices.create")).toHaveLength(1);
  });
});

describe("baseline", () => {
  it("skips submissions that existed when the automation was first enabled", async () => {
    await db.delete(billingRequestSubmissions);
    await db.delete(billingRequestSyncState);
    fake.addSubmission(1, ONE_OFF);
    fake.addSubmission(2, ONE_OFF);
    expect(await cycle()).toMatchObject({ status: "ok", discovered: 0, completed: 0 });
    expect(stripe.calls).toHaveLength(0);
    const [state] = await db.select().from(billingRequestSyncState);
    expect(state).toMatchObject({ formId: BR_FORM_ID, baselineSubmissionId: 2 });
    expect(await db.select().from(billingRequestSubmissions)).toHaveLength(0);

    fake.addSubmission(3, ONE_OFF);
    expect(await cycle()).toMatchObject({ discovered: 1, completed: 1 });
    expect(stripe.callsTo("invoices.create")).toHaveLength(1);
    expect((await sub(3)).status).toBe("completed");
    expect(await sub(1)).toBeUndefined();
  });
});

describe("results table", () => {
  it("is provisioned before any request, with the columns in order", async () => {
    const table = resultsTable();
    expect(table).toBeDefined();
    const titles = (fake.columns.get((table as { id: number }).id) ?? []).map((c) => c.title);
    expect(titles).toEqual([
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

  it("is shared read-only with the default groups", async () => {
    const id = (resultsTable() as { id: number }).id;
    const shares = fake.shares.filter((s) => s.nodeId === id);
    expect(shares.map((s) => s.receiver).sort()).toEqual(["dfwsc-admins", "managers"]);
    for (const share of shares) {
      expect(share).toMatchObject({
        receiverType: "group",
        permissionRead: true,
        permissionCreate: false,
        permissionUpdate: false,
        permissionDelete: false,
        permissionManage: false,
      });
    }
  });

  it("is shared with BILLING_REQUESTS_SHARE_GROUPS instead when set", async () => {
    await db.delete(portalMirrorState);
    resetBillingRequestsStateForTests();
    fake = new FakeBillingRequestNextcloud();
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
    await cycle(billingRequestEnv({ BILLING_REQUESTS_SHARE_GROUPS: "finance" }));
    const id = (resultsTable() as { id: number }).id;
    expect(fake.shares.filter((s) => s.nodeId === id).map((s) => s.receiver)).toEqual(["finance"]);
  });

  it("is created once and found again", async () => {
    await cycle();
    await cycle();
    expect(fake.tables.filter((t) => t.title === "Billing Requests")).toHaveLength(1);
    const state = await db
      .select()
      .from(portalMirrorState)
      .where(eq(portalMirrorState.key, "billing_requests_table_id"));
    expect(state).toHaveLength(1);
  });

  it("writes one row per request, updating it as the status changes", async () => {
    stripe.fail("invoices.create", apiError(503));
    await submit(91, ONE_OFF);
    expect(resultRows().map((r) => cell(r, "Status"))).toEqual(["Processing"]);
    await makeDue(91);
    await cycle();
    expect(resultRows().map((r) => cell(r, "Status"))).toEqual(["Sent"]);
    expect(cell(resultRows()[0], "Error")).toBe("");
  });

  it("still creates invoices when the table cannot be provisioned", async () => {
    await db.delete(portalMirrorState);
    resetBillingRequestsStateForTests();
    fake = new FakeBillingRequestNextcloud();
    fake.fail("GET", /\/tables$/, 404, 99);
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
    fake.addSubmission(92, ONE_OFF);
    await cycle();
    expect(await sub(92)).toMatchObject({ status: "completed", outcome: "sent", ncRowId: null });
  });
});

describe("what is logged", () => {
  it("carries ids and codes, never names, descriptions or amounts", async () => {
    stripe.fail("invoiceItems.create", apiError(503));
    await submit(101, { ...ONE_OFF, memo: "secret memo text" });
    await submit(102, { ...ONE_OFF, company: "Wrong Company Ltd" });
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("stripe.item:503");
    expect(text).toContain("company_mismatch");
    for (const secret of [
      "Emmut",
      "Wrong Company",
      "October retainer",
      "secret memo",
      "1500",
      "ap@emmut",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("stays on the platform account and never edits existing objects", () => {
  it("makes only creates, finalize, send and reads, and never passes stripeAccount", async () => {
    stripe.fail("invoiceItems.create", apiError(503));
    fake.addSubmission(111, ONE_OFF);
    fake.addSubmission(112, recurring());
    fake.addSubmission(113, { ...ONE_OFF, company: "Nope" });
    await cycle();
    await makeDue(111);
    await cycle();
    expect(stripe.calls.length).toBeGreaterThan(6);
    for (const call of stripe.calls) {
      expect(ALLOWED_CALLS.has(call.call)).toBe(true);
      expect(call.call).not.toMatch(
        /\.(update|del|cancel|voidInvoice|markUncollectible|pay|release|capture)$/
      );
      expect(call.options ?? {}).not.toHaveProperty("stripeAccount");
      expect(call.params ?? {}).not.toHaveProperty("stripeAccount");
      expect(JSON.stringify(call)).not.toContain("stripeAccount");
    }
    // Only ever against the client's own billing Customer.
    for (const call of stripe.calls.filter((c) => c.params?.customer)) {
      expect(call.params?.customer).toBe(CUSTOMER);
    }
  });

  it("has no update, cancel or stripeAccount in the code that talks to Stripe", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of ["billing-request-stripe.ts", "billing-request-sync.ts"]) {
      // Comments may name what the code avoids.
      const source = readFileSync(join(__dirname, "../../lib", file), "utf-8").replace(
        /^\s*\/\/.*$/gm,
        ""
      );
      expect(source).not.toMatch(/stripeAccount|stripe_account/);
      expect(source).not.toMatch(
        /stripe\.\w+\.(update|del|cancel|voidInvoice|markUncollectible|pay)\(/
      );
      expect(source).not.toMatch(
        /stripe\.(accounts|subscriptions|transfers|payouts|refunds|paymentIntents|checkout)/
      );
    }
  });
});

describe("form problems", () => {
  it("processes nothing and keeps the request waiting when the form lacks a question", async () => {
    fake.formQuestions = fake.formQuestions.filter((q) => q.name !== "amount_usd");
    fake.addSubmission(121, ONE_OFF);
    const result = await cycle();
    expect(result.status).toBe("config_error");
    expect(stripe.calls).toHaveLength(0);
    expect(await sub(121)).toMatchObject({ status: "pending", attempts: 0, claimedAt: null });
    expect(lines.some((l) => l.level === "error" && l.text.includes("amount_usd"))).toBe(true);

    fake.formQuestions.push({ id: BR_FORM_QUESTIONS.amount_usd, name: "amount_usd" });
    expect(await cycle()).toMatchObject({ status: "ok", completed: 1 });
  });

  it("keeps requests waiting while Nextcloud is down", async () => {
    fake.failForms(/\/submissions$/, 503, 1);
    fake.addSubmission(122, ONE_OFF);
    expect((await cycle()).status).toBe("nextcloud_unavailable");
    expect(stripe.calls).toHaveLength(0);
    expect(await cycle()).toMatchObject({ status: "ok", completed: 1 });
  });
});

describe("configuration", () => {
  const base = billingRequestEnv();
  it("is off unless enabled", () => {
    expect(loadBillingRequestsConfig({}).status).toBe("disabled");
    expect(loadBillingRequestsConfig({ BILLING_REQUESTS_ENABLED: "false" }).status).toBe(
      "disabled"
    );
    expect(loadBillingRequestsConfig({ ...base, BILLING_REQUESTS_ENABLED: "yes" }).status).toBe(
      "disabled"
    );
  });

  it("has the documented defaults", () => {
    const config = loadBillingRequestsConfig(base);
    expect(config.status).toBe("ready");
    if (config.status !== "ready") return;
    expect(config.settings).toMatchObject({
      formId: BR_FORM_ID,
      pollIntervalMs: 300_000,
      allowedGroups: ["dfwsc-admins", "managers"],
      shareGroups: ["dfwsc-admins", "managers"],
      maxAmountCents: 2_500_000,
      autoSend: true,
      daysUntilDue: 7,
      maxAgeHours: 72,
    });
  });

  it("reads every setting", () => {
    const config = loadBillingRequestsConfig({
      ...base,
      BILLING_REQUESTS_POLL_INTERVAL_MS: "60000",
      BILLING_REQUESTS_ALLOWED_GROUPS: " a , b ",
      BILLING_REQUESTS_SHARE_GROUPS: "c",
      BILLING_MAX_AMOUNT_CENTS: "100000",
      BILLING_AUTO_SEND: "false",
      BILLING_DEFAULT_DAYS_UNTIL_DUE: "14",
    });
    if (config.status !== "ready") throw new Error("not ready");
    expect(config.settings).toMatchObject({
      pollIntervalMs: 60_000,
      allowedGroups: ["a", "b"],
      shareGroups: ["c"],
      maxAmountCents: 100_000,
      autoSend: false,
      daysUntilDue: 14,
    });
  });

  it.each([
    [{ BILLING_REQUESTS_FORM_ID: "" }, "BILLING_REQUESTS_FORM_ID"],
    [{ BILLING_REQUESTS_FORM_ID: "abc" }, "BILLING_REQUESTS_FORM_ID"],
    [{ BILLING_REQUESTS_WEBHOOK_SECRET: "short" }, "BILLING_REQUESTS_WEBHOOK_SECRET"],
    [{ BILLING_REQUESTS_POLL_INTERVAL_MS: "10" }, "BILLING_REQUESTS_POLL_INTERVAL_MS"],
    [{ BILLING_MAX_AMOUNT_CENTS: "0" }, "BILLING_MAX_AMOUNT_CENTS"],
    [{ BILLING_MAX_AMOUNT_CENTS: "lots" }, "BILLING_MAX_AMOUNT_CENTS"],
    [{ BILLING_AUTO_SEND: "maybe" }, "BILLING_AUTO_SEND"],
    [{ BILLING_REQUESTS_MAX_AGE_HOURS: "0" }, "BILLING_REQUESTS_MAX_AGE_HOURS"],
    [{ BILLING_REQUESTS_MAX_AGE_HOURS: "soon" }, "BILLING_REQUESTS_MAX_AGE_HOURS"],
    [{ BILLING_DEFAULT_DAYS_UNTIL_DUE: "0" }, "BILLING_DEFAULT_DAYS_UNTIL_DUE"],
    [{ NEXTCLOUD_BASE_URL: undefined }, "NEXTCLOUD_BASE_URL"],
  ])("reports %j as invalid", (override, mentioned) => {
    const config = loadBillingRequestsConfig({ ...base, ...override } as NodeJS.ProcessEnv);
    expect(config.status).toBe("invalid");
    if (config.status === "invalid") expect(config.problems.join(" ")).toContain(mentioned);
  });

  it("never throws at start-up and starts nothing when disabled or invalid", () => {
    const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(startBillingRequests(silent, {})).toBeNull();
    expect(startBillingRequests(silent, { ...base, BILLING_AUTO_SEND: "maybe" })).toBeNull();
    expect(silent.error).toHaveBeenCalledTimes(1);
    expect(silent.error.mock.calls[0][0]).toHaveProperty("problems");
    expect(stripe.calls).toHaveLength(0);
  });

  it("does nothing in a cycle when invalid", async () => {
    const before = fake.calls.length + fake.formCalls.length;
    const result = await cycle({ ...base, BILLING_REQUESTS_FORM_ID: "x" } as NodeJS.ProcessEnv);
    expect(result.status).toBe("invalid_config");
    expect(fake.calls.length + fake.formCalls.length).toBe(before);
  });
});

describe("resuming never depends on the clock", () => {
  const DAY = 24 * 3600 * 1000;
  afterEach(() => {
    vi.useRealTimers();
  });
  const jumpDays = (days: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + days * DAY);
  };

  it("adopts a plan's schedule whose create answer was lost, even after its start date passed", async () => {
    stripe.fail("subscriptionSchedules.create", connectionError(), 1, true);
    await submit(131, recurring({ start_date: startDate(1) }));
    expect(await sub(131)).toMatchObject({
      status: "pending",
      stripeScheduleId: null,
      stripeProductId: expect.stringMatching(/^prod_/),
    });
    await makeDue(131);
    jumpDays(2); // the start (tomorrow 09:00 Chicago) is now in the past
    expect(await cycle()).toMatchObject({ completed: 1, failed: 0 });
    expect(await sub(131)).toMatchObject({
      status: "completed",
      outcome: "scheduled",
      lastErrorCode: null,
      stripeScheduleId: expect.stringMatching(/^sub_sched_/),
    });
    expect(stripe.created("subscriptionSchedules.create")).toHaveLength(1);
    expect(stripe.callsTo("subscriptionSchedules.create")).toHaveLength(1);
    expect(stripe.created("products.create")).toHaveLength(1);
    expect(cell(resultRows()[0], "Status")).toBe("Scheduled");
    expect(cell(resultRows()[0], "Stripe")).toBe(
      stripeScheduleUrl((await sub(131)).stripeScheduleId as string)
    );
  });

  it("refuses a passed start date only after looking, when something may have been sent", async () => {
    stripe.fail("subscriptionSchedules.create", apiError(502));
    await submit(132, recurring({ start_date: startDate(1) }));
    await makeDue(132);
    jumpDays(2);
    await cycle();
    expect(await sub(132)).toMatchObject({ status: "failed", lastErrorCode: "start_date_passed" });
    expect(stripe.callsTo("subscriptionSchedules.list").length).toBeGreaterThan(0);
    expect(stripe.callsTo("subscriptionSchedules.create")).toHaveLength(1); // the failed first one only
    expect(stripe.callsTo("products.create")).toHaveLength(1);
  });

  it("refuses a passed start date with no Stripe call at all when nothing was ever sent", async () => {
    fake.addSubmission(133, recurring({ start_date: startDate(1) }));
    jumpDays(2);
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect(await sub(133)).toMatchObject({ status: "failed", lastErrorCode: "start_date_passed" });
    expect(stripe.calls).toHaveLength(0);
  });

  it("adopts a one-off invoice whose create answer was lost, however old the request is now", async () => {
    stripe.fail("invoices.create", connectionError(), 1, true);
    await submit(134, ONE_OFF);
    expect((await sub(134)).stripeInvoiceId).toBeNull();
    await makeDue(134);
    await db
      .update(billingRequestSubmissions)
      .set({ submittedAt: new Date(Date.now() - 10 * DAY) }) // far beyond the 72 h age limit
      .where(eq(billingRequestSubmissions.submissionId, 134));
    expect(await cycle()).toMatchObject({ completed: 1, failed: 0 });
    expect(await sub(134)).toMatchObject({
      status: "completed",
      outcome: "sent",
      stripeInvoiceId: expect.stringMatching(/^in_/),
    });
    expect(stripe.callsTo("invoices.create")).toHaveLength(1);
    expect(stripe.created("invoiceItems.create")).toHaveLength(1);
    expect(stripe.created("invoices.sendInvoice")).toHaveLength(1);
    // Resumed without asking again: no second Customer check.
    expect(stripe.callsTo("customers.retrieve")).toHaveLength(1);
  });

  it("looks through every page of a busy Customer's invoices", async () => {
    stripe.fail("invoices.create", connectionError(), 1, true);
    await submit(135, ONE_OFF);
    stripe.pageSize = 2;
    stripe.searchResults["invoices.list"] = ["a", "b", "c", "d", "e"].map((x) => ({
      id: `in_foreign_${x}`,
      metadata: { nc_form: String(BR_FORM_ID), nc_submission: `9${x.charCodeAt(0)}` },
    }));
    await makeDue(135);
    await cycle();
    expect(await sub(135)).toMatchObject({ status: "completed", outcome: "sent" });
    expect(stripe.callsTo("invoices.create")).toHaveLength(1);
    const lists = stripe.callsTo("invoices.list");
    expect(lists).toHaveLength(3); // 5 foreign + ours = 6 objects, 2 per page, ours on page 3
    expect(lists.slice(1).every((c) => typeof c.params?.starting_after === "string")).toBe(true);
  });

  it("looks through every page of a busy Customer's schedules", async () => {
    stripe.fail("subscriptionSchedules.create", connectionError(), 1, true);
    await submit(136, recurring());
    stripe.pageSize = 2;
    stripe.searchResults["subscriptionSchedules.list"] = ["a", "b", "c"].map((x) => ({
      id: `sub_sched_foreign_${x}`,
      metadata: { nc_form: String(BR_FORM_ID), nc_submission: `8${x.charCodeAt(0)}` },
    }));
    await makeDue(136);
    await cycle();
    expect(await sub(136)).toMatchObject({ status: "completed", outcome: "scheduled" });
    expect(stripe.callsTo("subscriptionSchedules.create")).toHaveLength(1);
    expect(stripe.callsTo("subscriptionSchedules.list")).toHaveLength(2);
  });

  it("looks through every page of invoice items", async () => {
    stripe.fail("invoiceItems.create", connectionError(), 1, true);
    await submit(137, ONE_OFF);
    stripe.pageSize = 1;
    stripe.searchResults["invoiceItems.list"] = [
      { id: "ii_foreign", metadata: { nc_form: String(BR_FORM_ID), nc_submission: "1" } },
    ];
    await makeDue(137);
    await cycle();
    expect(await sub(137)).toMatchObject({ status: "completed" });
    expect(stripe.callsTo("invoiceItems.create")).toHaveLength(1);
    expect(stripe.callsTo("invoiceItems.list")).toHaveLength(2);
  });
});

describe("the Customer is checked before anything is created", () => {
  it("makes no write for a Customer without an email", async () => {
    stripe.customer = { email: null };
    await submit(141, ONE_OFF);
    expect(await sub(141)).toMatchObject({ status: "failed", lastErrorCode: "customer_no_email" });
    expect(stripe.calls.map((c) => c.call)).toEqual(["customers.retrieve"]);
    expect(stripe.calls[0].options ?? {}).not.toHaveProperty("stripeAccount");
    expect(stripe.calls[0].params).toMatchObject({ id: CUSTOMER });
    expect(cell(resultRows()[0], "Status")).toBe("Failed");
    expect(cell(resultRows()[0], "Error")).toBe("customer_no_email");
  });

  it("treats a blank email like none, and checks plans too", async () => {
    stripe.customer = { email: "  " };
    await submit(142, recurring());
    expect(await sub(142)).toMatchObject({ status: "failed", lastErrorCode: "customer_no_email" });
    expect(stripe.writes().length).toBe(0);
  });

  it.each([
    ["a deleted Customer", () => (stripe.customer = { deleted: true })],
    [
      "a Customer Stripe does not have (404)",
      () => stripe.fail("customers.retrieve", apiError(404)),
    ],
  ])("makes no write for %s", async (_name, arrange) => {
    arrange();
    await submit(143, ONE_OFF);
    expect(await sub(143)).toMatchObject({ status: "failed", lastErrorCode: "customer_missing" });
    expect(stripe.calls.map((c) => c.call)).toEqual(["customers.retrieve"]);
  });

  it("retries when the check itself cannot be made", async () => {
    stripe.fail("customers.retrieve", apiError(503));
    await submit(144, ONE_OFF);
    expect(await sub(144)).toMatchObject({
      status: "pending",
      lastErrorCode: "stripe.customer:503",
    });
    expect(stripe.writes().length).toBe(0);
    await makeDue(144);
    await cycle();
    expect((await sub(144)).status).toBe("completed");
  });

  it("checks once, not again when resuming", async () => {
    stripe.fail("invoiceItems.create", apiError(503));
    await submit(145, ONE_OFF);
    await makeDue(145);
    await cycle();
    expect(stripe.callsTo("customers.retrieve")).toHaveLength(1);
  });
});

describe("a finalized invoice that was not sent", () => {
  it("is shown as Finalized, not sent, with the link and code, and not retried on a permanent error", async () => {
    stripe.fail("invoices.sendInvoice", apiError(400));
    await submit(151, ONE_OFF);
    const row = await sub(151);
    expect(row).toMatchObject({ status: "failed", lastErrorCode: "stripe.send:400" });
    expect(row.invoiceFinalizedAt).not.toBeNull();
    expect(row.invoiceSentAt).toBeNull();
    const [shown] = resultRows();
    expect(cell(shown, "Status")).toBe("Finalized, not sent");
    expect(cell(shown, "Error")).toBe("stripe.send:400");
    expect(cell(shown, "Stripe")).toBe(stripeInvoiceUrl(row.stripeInvoiceId as string));
    await makeDue(151);
    await cycle();
    expect(stripe.callsTo("invoices.sendInvoice")).toHaveLength(1);
  });

  it("retries only the send on retryable errors, then reads Sent", async () => {
    stripe.fail("invoices.sendInvoice", apiError(503), 2);
    await submit(152, ONE_OFF);
    expect(cell(resultRows()[0], "Status")).toBe("Processing");
    await makeDue(152);
    await cycle();
    await makeDue(152);
    await cycle();
    expect(await sub(152)).toMatchObject({ status: "completed", outcome: "sent" });
    expect(stripe.callsTo("invoices.sendInvoice")).toHaveLength(3);
    expect(stripe.callsTo("invoices.finalizeInvoice")).toHaveLength(1);
    expect(stripe.callsTo("invoices.create")).toHaveLength(1);
    expect(cell(resultRows()[0], "Status")).toBe("Sent");
  });

  it("is Finalized, not sent once the send's retries are used up", async () => {
    stripe.fail("invoices.sendInvoice", apiError(503), 999);
    await submit(153, ONE_OFF);
    for (let i = 1; i < BILLING_REQUESTS_MAX_ATTEMPTS; i++) {
      resetCircuitBreakersForTests();
      await makeDue(153);
      await cycle();
    }
    expect(await sub(153)).toMatchObject({ status: "failed", lastErrorCode: "stripe.send:503" });
    expect(cell(resultRows()[0], "Status")).toBe("Finalized, not sent");
    expect(stripe.callsTo("invoices.finalizeInvoice")).toHaveLength(1);
  });
});

describe("requests that are too old", () => {
  const DAY = 24 * 3600 * 1000;
  const old = (id: number, answers: BillingAnswers, ageMs: number, env = on) => {
    fake.addSubmission(id, answers, { timestamp: Math.floor((Date.now() - ageMs) / 1000) });
    return cycle(env);
  };

  it("marks a submission made while the flag was off, found 4 days later, Expired with no Stripe call", async () => {
    // Baseline was recorded earlier; the submission came in afterwards, while the feature was off.
    const result = await old(161, ONE_OFF, 4 * DAY);
    expect(result).toMatchObject({ failed: 1, completed: 0 });
    expect(stripe.calls).toHaveLength(0);
    expect(await sub(161)).toMatchObject({
      status: "failed",
      lastErrorCode: "request_expired",
      attempts: 1,
    });
    const [row] = resultRows();
    expect(cell(row, "Status")).toBe("Expired");
    expect(cell(row, "Error")).toBe("request_expired");
    expect(cell(row, "Stripe")).toBe("");
    await makeDue(161);
    await cycle();
    expect(stripe.calls).toHaveLength(0);
  });

  it("expires plans too", async () => {
    await old(162, recurring(), 5 * DAY);
    expect(await sub(162)).toMatchObject({ status: "failed", lastErrorCode: "request_expired" });
    expect(stripe.calls).toHaveLength(0);
  });

  it("still bills a request just inside the limit", async () => {
    await old(163, ONE_OFF, 71 * 3600 * 1000);
    expect(await sub(163)).toMatchObject({ status: "completed", outcome: "sent" });
  });

  it("uses BILLING_REQUESTS_MAX_AGE_HOURS", async () => {
    await old(
      164,
      ONE_OFF,
      2 * 3600 * 1000,
      billingRequestEnv({ BILLING_REQUESTS_MAX_AGE_HOURS: "1" })
    );
    expect(await sub(164)).toMatchObject({ status: "failed", lastErrorCode: "request_expired" });
    await old(
      165,
      ONE_OFF,
      2 * 3600 * 1000,
      billingRequestEnv({ BILLING_REQUESTS_MAX_AGE_HOURS: "3" })
    );
    expect((await sub(165)).status).toBe("completed");
  });

  it("does not expire a request Stripe was already called for", async () => {
    stripe.fail("invoiceItems.create", apiError(503));
    await submit(166, ONE_OFF);
    await db
      .update(billingRequestSubmissions)
      .set({ submittedAt: new Date(Date.now() - 30 * DAY) })
      .where(eq(billingRequestSubmissions.submissionId, 166));
    await makeDue(166);
    await cycle();
    expect(await sub(166)).toMatchObject({ status: "completed", outcome: "sent" });
    expect(stripe.callsTo("invoices.create")).toHaveLength(1);
  });
});

describe("client codes", () => {
  it("match without regard to case or surrounding spaces on either side", async () => {
    await db.insert(billingCustomers).values({
      clientCode: " cp-006 ",
      company: "Lower Case Co",
      email: "ap@lower.example",
      stripeCustomerId: "cus_lower",
      source: "created",
    });
    await submit(171, { ...ONE_OFF, client_code: "  CP-006  ", company: "Lower Case Co" });
    expect(await sub(171)).toMatchObject({ status: "completed", clientCode: " cp-006 " });
    expect(stripe.callsTo("invoices.create")[0].params?.customer).toBe("cus_lower");
  });

  it("refuses a code that two clients differ in only by case, instead of guessing", async () => {
    await db.insert(billingCustomers).values({
      clientCode: "cp-004",
      company: "Emmut Properties Corp.",
      email: "other@emmut.example",
      stripeCustomerId: "cus_dupe",
      source: "created",
    });
    await submit(172, ONE_OFF);
    expect(await sub(172)).toMatchObject({
      status: "failed",
      lastErrorCode: "ambiguous_client_code",
    });
    expect(stripe.calls).toHaveLength(0);
  });
});

describe("the age limit holds unless an object is actually found", () => {
  const DAY = 24 * 3600 * 1000;
  const ageBy = (id: number, days: number) =>
    db
      .update(billingRequestSubmissions)
      .set({ submittedAt: new Date(Date.now() - days * DAY) })
      .where(eq(billingRequestSubmissions.submissionId, id));
  const META = (id: number) => ({ nc_form: String(BR_FORM_ID), nc_submission: String(id) });

  it("expires a one-off whose first create failed outright and which then stalled past the limit", async () => {
    stripe.fail("invoices.create", apiError(503));
    await submit(181, ONE_OFF);
    expect(await sub(181)).toMatchObject({ status: "pending", stripeInvoiceId: null });
    expect((await sub(181)).stripeStartedAt).not.toBeNull();
    await ageBy(181, 4);
    await makeDue(181);
    await cycle();
    expect(await sub(181)).toMatchObject({ status: "failed", lastErrorCode: "request_expired" });
    expect(stripe.callsTo("invoices.create")).toHaveLength(1); // the failed first one only
    expect(stripe.callsTo("invoices.list").length).toBeGreaterThan(0); // it did look first
    expect(stripe.created("invoices.create")).toHaveLength(0);
    expect(cell(resultRows()[0], "Status")).toBe("Expired");
  });

  it("expires a plan whose first create failed and which then stalled, without making a product", async () => {
    stripe.fail("products.create", apiError(503));
    await submit(182, recurring());
    await ageBy(182, 4);
    await makeDue(182);
    await cycle();
    expect(await sub(182)).toMatchObject({ status: "failed", lastErrorCode: "request_expired" });
    expect(stripe.callsTo("subscriptionSchedules.list").length).toBeGreaterThan(0);
    expect(stripe.callsTo("products.create")).toHaveLength(1);
    expect(stripe.callsTo("subscriptionSchedules.create")).toHaveLength(0);
    expect(cell(resultRows()[0], "Status")).toBe("Expired");
  });

  it("does not let a saved Product alone rescue an old plan", async () => {
    stripe.fail("subscriptionSchedules.create", apiError(503));
    await submit(186, recurring());
    expect(await sub(186)).toMatchObject({
      status: "pending",
      stripeProductId: expect.stringMatching(/^prod_/),
      stripeScheduleId: null,
    });
    await ageBy(186, 4);
    await makeDue(186);
    await cycle();
    expect(await sub(186)).toMatchObject({ status: "failed", lastErrorCode: "request_expired" });
    expect(stripe.callsTo("subscriptionSchedules.list").length).toBeGreaterThan(0);
    expect(stripe.callsTo("subscriptionSchedules.create")).toHaveLength(1); // the failed first one only
    expect(stripe.created("subscriptionSchedules.create")).toHaveLength(0);
    expect(cell(resultRows()[0], "Status")).toBe("Expired");
  });

  it("still adopts an object that exists, at any age: a one-off invoice", async () => {
    stripe.fail("invoices.create", connectionError(), 1, true);
    await submit(183, ONE_OFF);
    await ageBy(183, 20);
    await makeDue(183);
    await cycle();
    expect(await sub(183)).toMatchObject({ status: "completed", outcome: "sent" });
    expect(stripe.callsTo("invoices.create")).toHaveLength(1);
  });

  it("still adopts an object that exists, at any age: a plan's schedule", async () => {
    stripe.fail("subscriptionSchedules.create", connectionError(), 1, true);
    await submit(184, recurring());
    await ageBy(184, 20);
    await makeDue(184);
    await cycle();
    expect(await sub(184)).toMatchObject({ status: "completed", outcome: "scheduled" });
    expect(stripe.callsTo("subscriptionSchedules.create")).toHaveLength(1);
  });

  it("resumes at any age once an id is saved", async () => {
    stripe.fail("invoiceItems.create", apiError(503));
    await submit(185, ONE_OFF);
    await ageBy(185, 20);
    await makeDue(185);
    await cycle();
    expect(await sub(185)).toMatchObject({ status: "completed", outcome: "sent" });
  });

  describe("an object with the same metadata on another Customer", () => {
    const foreign = (id: number) => ({ ...META(id) });

    it("is never adopted as an invoice", async () => {
      stripe.fail("invoices.create", apiError(503));
      await submit(191, ONE_OFF);
      stripe.searchResults["invoices.list"] = [
        { id: "in_decoy", customer: "cus_other", metadata: foreign(191) },
      ];
      await makeDue(191);
      await cycle();
      const row = await sub(191);
      expect(row.status).toBe("completed");
      expect(row.stripeInvoiceId).not.toBe("in_decoy");
      expect(stripe.created("invoices.create")).toHaveLength(1);
    });

    it("is never adopted as a schedule, and does not stop the real one being created", async () => {
      stripe.fail("products.create", apiError(503));
      await submit(192, recurring());
      stripe.searchResults["subscriptionSchedules.list"] = [
        { id: "sub_sched_decoy", customer: "cus_other", metadata: foreign(192) },
      ];
      await makeDue(192);
      await cycle();
      const row = await sub(192);
      expect(row).toMatchObject({ status: "completed", outcome: "scheduled" });
      expect(row.stripeScheduleId).not.toBe("sub_sched_decoy");
      expect(stripe.created("subscriptionSchedules.create")).toHaveLength(1);
    });

    it("does not rescue an expired request", async () => {
      stripe.fail("invoices.create", apiError(503));
      await submit(193, ONE_OFF);
      stripe.searchResults["invoices.list"] = [
        { id: "in_decoy", customer: "cus_other", metadata: foreign(193) },
      ];
      await ageBy(193, 4);
      await makeDue(193);
      await cycle();
      expect(await sub(193)).toMatchObject({
        status: "failed",
        lastErrorCode: "request_expired",
        stripeInvoiceId: null,
      });
    });

    it("is ignored when it is older than the request (created filter)", async () => {
      stripe.fail("invoices.create", apiError(503));
      await submit(194, ONE_OFF);
      stripe.searchResults["invoices.list"] = [
        {
          id: "in_old_same_customer",
          customer: CUSTOMER,
          created: 1_000_000,
          metadata: foreign(194),
        },
      ];
      await makeDue(194);
      await cycle();
      expect((await sub(194)).stripeInvoiceId).not.toBe("in_old_same_customer");
      expect(stripe.created("invoices.create")).toHaveLength(1);
    });
  });
});
