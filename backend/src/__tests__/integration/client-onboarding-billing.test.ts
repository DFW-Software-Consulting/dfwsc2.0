import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import {
  billingCustomers,
  clientOnboardingSubmissions,
  clientOnboardingSyncState,
  clients,
} from "../../db/schema";
import { ensureBillingCustomer, linkPinnedBillingCustomer } from "../../lib/billing-customer";
import {
  resetClientOnboardingStateForTests,
  runClientOnboardingCycle,
} from "../../lib/client-onboarding-sync";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { stripe } from "../../lib/stripe";
import {
  BILLING_EMAIL_QUESTION,
  FakeOnboardingNextcloud,
  type IntakeAnswers,
  ONB_FORM_ID,
  onboardingEnv,
} from "../helpers/fake-nextcloud-onboarding";

type Logger = Parameters<typeof runClientOnboardingCycle>[0]["logger"];

const LEAD_ROW = 301;
const FULL: IntakeAnswers = {
  company: "Zephyrine Widgets LLC",
  contact_name: "Ophelia Quartermaine",
  email: " Ophelia@Zephyrine.example ",
  phone: "+1 214 555 0199",
  project_name: "Warehouse Portal",
  start_date: "2026-11-02",
  target_date: "2027-01-29",
  summary: "Build the warehouse portal MVP",
  lead_link: `https://cloud.test/apps/tables/#/table/8/row/${LEAD_ROW}`,
};

let fake: FakeOnboardingNextcloud;
let lines: { level: string; text: string }[];
const on = onboardingEnv({ CLIENT_ONBOARDING_BILLING_CUSTOMER: "true" });

function logger(): Logger {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, text: JSON.stringify(args) });
    };
  return { info: rec("info"), warn: rec("warn"), error: rec("error") } as unknown as Logger;
}

const cycle = (env: NodeJS.ProcessEnv = on) => runClientOnboardingCycle({ logger: logger(), env });

async function sub(submissionId: number) {
  const rows = await db
    .select()
    .from(clientOnboardingSubmissions)
    .where(eq(clientOnboardingSubmissions.submissionId, submissionId));
  return rows[0];
}

const makeDue = (submissionId: number) =>
  db
    .update(clientOnboardingSubmissions)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(eq(clientOnboardingSubmissions.submissionId, submissionId));

const customerList = (...ids: string[]) =>
  ({ data: ids.map((id) => ({ id })) }) as unknown as Stripe.Response<
    Stripe.ApiList<Stripe.Customer>
  >;
const customer = (id: string) => ({ id }) as unknown as Stripe.Response<Stripe.Customer>;

let list: ReturnType<typeof vi.spyOn>;
let create: ReturnType<typeof vi.spyOn>;
let accounts: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await db.delete(clientOnboardingSubmissions);
  await db.delete(clientOnboardingSyncState);
  await db.delete(billingCustomers);
  resetNextcloudBreakerForTests();
  resetClientOnboardingStateForTests();
  lines = [];
  fake = new FakeOnboardingNextcloud();
  fake.addLead(LEAD_ROW, "Zephyrine Widgets LLC");
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  list = vi.spyOn(stripe.customers, "list").mockResolvedValue(customerList());
  create = vi.spyOn(stripe.customers, "create").mockResolvedValue(customer("cus_new"));
  accounts = vi
    .spyOn(stripe.accounts, "create")
    .mockRejectedValue(new Error("billing must not provision Connect accounts"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetNextcloudBreakerForTests();
  resetClientOnboardingStateForTests();
});

async function onboard(env: NodeJS.ProcessEnv = on) {
  expect((await cycle(env)).status).toBe("ok");
  fake.addSubmission(5, FULL);
  return cycle(env);
}

describe("billing customer step: onboarding flow", () => {
  it("does nothing with Stripe when the flag is off", async () => {
    expect(await onboard(onboardingEnv())).toMatchObject({ completed: 1 });
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await sub(5)).toMatchObject({ billingStatus: null, billingCustomerId: null });
    expect(await db.select().from(billingCustomers)).toHaveLength(0);
  });

  it("creates a Customer on the platform account and records it, with no Connect side effects", async () => {
    const clientsBefore = await db.select().from(clients);
    expect(await onboard()).toMatchObject({ completed: 1 });
    expect(list).toHaveBeenCalledTimes(2); // lowercased and raw trimmed email
    expect(list).toHaveBeenCalledWith({ email: "ophelia@zephyrine.example", limit: 10 });
    expect(list).toHaveBeenCalledWith({ email: "Ophelia@Zephyrine.example", limit: 10 });
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params).toEqual({
      name: "Zephyrine Widgets LLC",
      email: "Ophelia@Zephyrine.example",
      metadata: { client_code: "CP-003", source: "dfwsc-onboarding", submission_id: "5" },
    });
    expect(options.idempotencyKey).toMatch(/^onboarding-customer-[0-9a-f]{64}$/);
    expect(options).not.toHaveProperty("stripeAccount");
    expect(params).not.toHaveProperty("stripeAccount");
    expect(await sub(5)).toMatchObject({ billingStatus: "linked", billingCustomerId: "cus_new" });
    const [row] = await db.select().from(billingCustomers);
    expect(row).toMatchObject({
      clientCode: "CP-003",
      company: "Zephyrine Widgets LLC",
      email: "ophelia@zephyrine.example",
      stripeCustomerId: "cus_new",
      source: "created",
    });
    expect(accounts).not.toHaveBeenCalled();
    expect(await db.select().from(clients)).toEqual(clientsBefore);
  });

  it("reuses a Customer found by email without modifying it", async () => {
    const update = vi.spyOn(stripe.customers, "update");
    list.mockResolvedValueOnce(customerList("cus_dash"));
    expect(await onboard()).toMatchObject({ completed: 1 });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await sub(5)).toMatchObject({ billingStatus: "linked", billingCustomerId: "cus_dash" });
    const [row] = await db.select().from(billingCustomers);
    expect(row).toMatchObject({ stripeCustomerId: "cus_dash", source: "matched" });
  });

  it("flags several matches as ambiguous, creates nothing and still completes", async () => {
    list.mockResolvedValue(customerList("cus_a", "cus_b"));
    expect(await onboard()).toMatchObject({ completed: 1 });
    expect(create).not.toHaveBeenCalled();
    expect(await sub(5)).toMatchObject({ billingStatus: "ambiguous", billingCustomerId: null });
    expect(await db.select().from(billingCustomers)).toHaveLength(0);
    const warn = lines.find((l) => l.level === "warn" && l.text.includes("ambiguous"));
    expect(warn?.text).not.toMatch(/zephyrine|ophelia|cus_/i);
  });

  it("flags a missing email without calling Stripe", async () => {
    expect((await cycle()).status).toBe("ok");
    fake.addSubmission(5, { ...FULL, email: undefined });
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(list).not.toHaveBeenCalled();
    expect(await sub(5)).toMatchObject({ billingStatus: "no_email" });
  });

  it("keeps the submission pending and retries only the Stripe step when Stripe is down", async () => {
    list.mockRejectedValue(
      Stripe.errors.StripeError.generate({
        type: "api_error",
        statusCode: 503,
        message: "down",
      } as never)
    );
    expect(await onboard()).toMatchObject({ retried: 1, completed: 0 });
    expect(await sub(5)).toMatchObject({
      status: "pending",
      lastErrorCode: "stripe.customer:503",
      billingStatus: null,
      projectCode: "CP-003",
    });
    expect(lines.some((l) => l.text.includes("zephyrine"))).toBe(false);
    const writes = fake.writes().length;
    list.mockResolvedValue(customerList());
    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.writes().length).toBe(writes); // no Nextcloud step repeated
    expect(await sub(5)).toMatchObject({
      status: "completed",
      lastErrorCode: null,
      billingStatus: "linked",
    });
  });

  it("retries on a Stripe authentication error and heals once the key is fixed", async () => {
    list.mockRejectedValue(
      Stripe.errors.StripeError.generate({
        type: "authentication_error",
        statusCode: 401,
        message: "bad key",
      } as never)
    );
    expect(await onboard()).toMatchObject({ retried: 1, failed: 0 });
    expect(await sub(5)).toMatchObject({ status: "pending", lastErrorCode: "stripe.customer:401" });
    list.mockResolvedValue(customerList());
    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(await sub(5)).toMatchObject({ status: "completed", billingStatus: "linked" });
  });

  it("fails permanently on another Stripe invalid request", async () => {
    list.mockRejectedValue(
      Stripe.errors.StripeError.generate({
        type: "invalid_request_error",
        statusCode: 400,
        message: "bad",
        param: "limit",
      } as never)
    );
    expect(await onboard()).toMatchObject({ failed: 1 });
    expect(await sub(5)).toMatchObject({ status: "failed", lastErrorCode: "stripe.customer:400" });
  });

  it("treats an invalid contact email as no_email without calling Stripe", async () => {
    expect((await cycle()).status).toBe("ok");
    fake.addSubmission(5, { ...FULL, email: "not-an-email" });
    expect(await cycle()).toMatchObject({ completed: 1, failed: 0 });
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await sub(5)).toMatchObject({ billingStatus: "no_email" });
    const warn = lines.find((l) => l.text.includes("contact_email_invalid"));
    expect(warn?.text).not.toMatch(/not-an-email|zephyrine/i);
  });

  it("uses a valid contact email when the billing email is invalid, and none when both are", async () => {
    fake.questions.push({ ...BILLING_EMAIL_QUESTION });
    expect((await cycle()).status).toBe("ok");
    fake.addSubmission(5, { ...FULL, email: "bad", billing_email: "also bad" });
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(list).not.toHaveBeenCalled();
    expect(await sub(5)).toMatchObject({ billingStatus: "no_email" });
  });

  it("records no_email when Stripe itself rejects the email", async () => {
    list.mockRejectedValue(
      Stripe.errors.StripeError.generate({
        type: "invalid_request_error",
        statusCode: 400,
        message: "Invalid email address",
        param: "email",
      } as never)
    );
    expect(await onboard()).toMatchObject({ completed: 1, failed: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(await sub(5)).toMatchObject({ status: "completed", billingStatus: "no_email" });
    expect(await db.select().from(billingCustomers)).toHaveLength(0);
  });

  it("does not call Stripe again once the Customer is recorded", async () => {
    expect(await onboard()).toMatchObject({ completed: 1 });
    await db
      .update(clientOnboardingSubmissions)
      .set({ status: "pending", completedAt: null })
      .where(eq(clientOnboardingSubmissions.submissionId, 5));
    await makeDue(5);
    list.mockClear();
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(list).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("billing email question", () => {
  const withQuestion = () => fake.questions.push({ ...BILLING_EMAIL_QUESTION });

  it("uses a valid billing email for the lookup, the create and the stored row", async () => {
    withQuestion();
    expect((await cycle()).status).toBe("ok");
    fake.addSubmission(5, { ...FULL, billing_email: " AP@Zephyrine.example " });
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(list).toHaveBeenCalledWith({ email: "ap@zephyrine.example", limit: 10 });
    expect(list).not.toHaveBeenCalledWith({ email: "ophelia@zephyrine.example", limit: 10 });
    expect((create.mock.calls[0][0] as { email: string }).email).toBe("AP@Zephyrine.example");
    const [row] = await db.select().from(billingCustomers);
    expect(row.email).toBe("ap@zephyrine.example");
  });

  it("falls back to the contact email when the question exists but is empty", async () => {
    withQuestion();
    expect((await cycle()).status).toBe("ok");
    fake.addSubmission(5, { ...FULL, billing_email: "  " });
    expect(await cycle()).toMatchObject({ completed: 1 });
    const [row] = await db.select().from(billingCustomers);
    expect(row.email).toBe("ophelia@zephyrine.example");
  });

  it("falls back to the contact email, with a PII-free warning, when it is invalid", async () => {
    withQuestion();
    expect((await cycle()).status).toBe("ok");
    fake.addSubmission(5, { ...FULL, billing_email: "not an email" });
    expect(await cycle()).toMatchObject({ completed: 1, failed: 0, retried: 0 });
    const [row] = await db.select().from(billingCustomers);
    expect(row.email).toBe("ophelia@zephyrine.example");
    const warn = lines.find((l) => l.text.includes("billing_email_invalid"));
    expect(warn?.level).toBe("warn");
    expect(warn?.text).not.toMatch(/not an email|zephyrine/i);
  });

  it("works unchanged on a form without the question (the default form)", async () => {
    expect(await onboard()).toMatchObject({ completed: 1 });
    const [row] = await db.select().from(billingCustomers);
    expect(row.email).toBe("ophelia@zephyrine.example");
  });

  it("ignores an unknown extra question and an unflagged billing flag-off run", async () => {
    fake.questions.push({ id: 999, name: "something_new", text: "Something new" });
    expect(await onboard(onboardingEnv())).toMatchObject({ completed: 1 });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("ensureBillingCustomer", () => {
  const input = { clientCode: "CP-010", company: "Acme", email: "AP@Acme.example" };

  it("is idempotent for one client code concurrently (DB upsert; Stripe is mocked)", async () => {
    const results = await Promise.all([
      ensureBillingCustomer(input),
      ensureBillingCustomer(input),
      ensureBillingCustomer(input),
    ]);
    for (const r of results)
      expect(r).toMatchObject({ status: "linked", stripeCustomerId: "cus_new" });
    expect(await db.select().from(billingCustomers)).toHaveLength(1);
    const keys = create.mock.calls.map(
      (c: unknown[]) => (c[1] as { idempotencyKey: string }).idempotencyKey
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("returns the row already recorded for the client code", async () => {
    await db.insert(billingCustomers).values({
      clientCode: "CP-010",
      company: "Acme",
      email: "ap@acme.example",
      stripeCustomerId: "cus_winner",
      source: "created",
    });
    expect(await ensureBillingCustomer(input)).toMatchObject({ stripeCustomerId: "cus_winner" });
  });

  it("shares one Customer between client codes with the same email, without asking Stripe", async () => {
    await ensureBillingCustomer(input);
    list.mockClear();
    create.mockClear();
    const second = await ensureBillingCustomer({ ...input, clientCode: "CP-011" });
    expect(second).toMatchObject({
      status: "linked",
      stripeCustomerId: "cus_new",
      source: "matched",
    });
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await db.select().from(billingCustomers)).toHaveLength(2);
  });

  it("matches the raw email when only that casing exists in Stripe", async () => {
    list.mockImplementation((async (p: { email: string }) =>
      p.email === "AP@Acme.example" ? customerList("cus_raw") : customerList()) as never);
    expect(await ensureBillingCustomer(input)).toMatchObject({ stripeCustomerId: "cus_raw" });
    expect(create).not.toHaveBeenCalled();
  });

  it("dedupes the same Customer returned for both email variants", async () => {
    list.mockResolvedValue(customerList("cus_same"));
    expect(await ensureBillingCustomer(input)).toMatchObject({ stripeCustomerId: "cus_same" });
  });

  it("falls back to the existing Customer when Stripe reports an idempotency conflict", async () => {
    create.mockRejectedValueOnce(
      Stripe.errors.StripeError.generate({
        type: "idempotency_error",
        statusCode: 400,
        message: "reused",
      } as never)
    );
    list.mockResolvedValueOnce(customerList()).mockResolvedValueOnce(customerList());
    list.mockResolvedValue(customerList("cus_first"));
    expect(await ensureBillingCustomer(input)).toMatchObject({
      status: "linked",
      stripeCustomerId: "cus_first",
    });
  });

  it("classifies a connection error as retryable", async () => {
    create.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: "x" } as never)
    );
    await expect(ensureBillingCustomer(input)).rejects.toMatchObject({ retryable: true });
    expect(await db.select().from(billingCustomers)).toHaveLength(0);
  });
});

describe("linkPinnedBillingCustomer", () => {
  const input = { clientCode: "CP-020", company: "Acme", email: "ap@acme.example" };

  it("links a Customer that exists, without modifying it", async () => {
    const retrieve = vi
      .spyOn(stripe.customers, "retrieve")
      .mockResolvedValue({ id: "cus_pin" } as never);
    const update = vi.spyOn(stripe.customers, "update");
    expect(await linkPinnedBillingCustomer(input, "cus_pin")).toMatchObject({
      status: "linked",
      stripeCustomerId: "cus_pin",
      source: "backfill",
    });
    expect(retrieve).toHaveBeenCalledWith("cus_pin");
    expect(update).not.toHaveBeenCalled();
    expect(await db.select().from(billingCustomers)).toHaveLength(1);
  });

  it("refuses a deleted Customer and writes nothing", async () => {
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_gone",
      deleted: true,
    } as never);
    await expect(linkPinnedBillingCustomer(input, "cus_gone")).rejects.toMatchObject({
      code: "stripe.customer:deleted",
      retryable: false,
    });
    expect(await db.select().from(billingCustomers)).toHaveLength(0);
  });
});
