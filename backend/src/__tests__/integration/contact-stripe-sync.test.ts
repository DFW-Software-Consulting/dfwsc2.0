import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import {
  billingCustomers,
  clientOnboardingSubmissions,
  clientOnboardingSyncState,
  contactStripeSyncBooks,
  contactStripeSyncCards,
} from "../../db/schema";
import {
  resetClientOnboardingStateForTests,
  runClientOnboardingCycle,
} from "../../lib/client-onboarding-sync";
import { countryCode, mapCardToStripe } from "../../lib/contact-stripe-fields";
import {
  resetContactStripeSyncStateForTests,
  runContactStripeSyncCycle,
  startContactStripeSync,
} from "../../lib/contact-stripe-sync";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { stripe } from "../../lib/stripe";
import {
  BILLING_EMAIL_QUESTION,
  FakeOnboardingNextcloud,
  ONB_FORM_ID,
  onboardingEnv,
} from "../helpers/fake-nextcloud-onboarding";

type Logger = Parameters<typeof runContactStripeSyncCycle>[0]["logger"];

const on = onboardingEnv({ CONTACT_STRIPE_SYNC: "true" });
const UID_A = `dfwsc-client-${ONB_FORM_ID}-5`;
const UID_B = `dfwsc-client-${ONB_FORM_ID}-6`;

let fake: FakeOnboardingNextcloud;
let lines: { level: string; text: string }[];
let update: ReturnType<typeof vi.spyOn>;
let accounts: ReturnType<typeof vi.spyOn>;

function logger(): Logger {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, text: JSON.stringify(args) });
    };
  return { info: rec("info"), warn: rec("warn"), error: rec("error") } as unknown as Logger;
}

const cycle = (env: NodeJS.ProcessEnv = on) => runContactStripeSyncCycle({ logger: logger(), env });

function vcard(uid: string, body: string[], rev = "20261101T100000Z"): string {
  return `${["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, ...body, `REV:${rev}`, "END:VCARD"].join("\r\n")}\r\n`;
}

const BASE = [
  "FN:Ophelia Quartermaine",
  "ORG:Zephyrine Widgets LLC",
  "EMAIL;TYPE=WORK:ap@zephyrine.example",
  "TEL;TYPE=WORK:+1 214 555 0199",
  "ADR;TYPE=WORK:;;100 Main St;Dallas;TX;75201;United States",
];
const withBase = (...replace: [prefix: string, line: string | null][]) => {
  let out = [...BASE];
  for (const [prefix, line] of replace) {
    out = out.filter((l) => !l.startsWith(prefix));
    if (line) out.push(line);
  }
  return out;
};

const putCard = (uid: string, body: string[], rev?: string) =>
  fake.addCard(`${uid}.vcf`, vcard(uid, body, rev));

async function link(submissionId: number, clientCode: string, customerId: string, table = true) {
  await db.insert(clientOnboardingSubmissions).values({
    formId: ONB_FORM_ID,
    submissionId,
    status: "completed",
    contactStatus: "created",
    contactUid: `dfwsc-client-${ONB_FORM_ID}-${submissionId}`,
    projectCode: clientCode,
    billingStatus: "linked",
    billingCustomerId: customerId,
  });
  if (table) {
    await db.insert(billingCustomers).values({
      clientCode,
      company: "Zephyrine Widgets LLC",
      email: `x${submissionId}@zephyrine.example`,
      stripeCustomerId: customerId,
      source: "matched",
    });
  }
}

const stateOf = async (uid: string) =>
  (
    await db.select().from(contactStripeSyncCards).where(eq(contactStripeSyncCards.contactUid, uid))
  )[0];
const tokenOf = async () => (await db.select().from(contactStripeSyncBooks))[0]?.syncToken ?? null;
const syncReports = () =>
  fake.requests.filter((r) => r.method === "REPORT" && r.body.includes("sync-collection"));

beforeEach(async () => {
  await db.delete(contactStripeSyncCards);
  await db.delete(contactStripeSyncBooks);
  await db.delete(clientOnboardingSubmissions);
  await db.delete(clientOnboardingSyncState);
  await db.delete(billingCustomers);
  resetNextcloudBreakerForTests();
  resetClientOnboardingStateForTests();
  resetContactStripeSyncStateForTests();
  lines = [];
  fake = new FakeOnboardingNextcloud();
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  update = vi
    .spyOn(stripe.customers, "update")
    .mockResolvedValue({ id: "cus_x" } as unknown as Stripe.Response<Stripe.Customer>);
  accounts = vi
    .spyOn(stripe.accounts, "create")
    .mockRejectedValue(new Error("the contact sync must not provision Connect accounts"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetNextcloudBreakerForTests();
  resetClientOnboardingStateForTests();
});

/** One linked card, baselined by a first cycle. */
async function baselined(body: string[] = BASE) {
  await link(5, "CP-003", "cus_dash");
  putCard(UID_A, body);
  const first = await cycle();
  expect(first).toMatchObject({ status: "ok", baselined: 1, pushed: 0 });
  expect(update).not.toHaveBeenCalled();
}

describe("flag and poller", () => {
  it("is off by default: no cycle work, no poller, no Nextcloud call", async () => {
    await link(5, "CP-003", "cus_dash");
    putCard(UID_A, BASE);
    const off = onboardingEnv();
    expect(await cycle(off)).toMatchObject({ status: "disabled" });
    expect(await cycle(onboardingEnv({ CONTACT_STRIPE_SYNC: "false" }))).toMatchObject({
      status: "disabled",
    });
    expect(startContactStripeSync(logger(), off)).toBeNull();
    expect(fake.requests).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("starts a poller when the flag is on and stops cleanly", async () => {
    const runner = startContactStripeSync(logger(), on);
    expect(runner).not.toBeNull();
    runner?.trigger();
    await runner?.stop();
    expect(lines.some((l) => l.text.includes("Contact to Stripe sync started"))).toBe(true);
  });

  it("does not start with a bad interval or missing Nextcloud config, and says why", async () => {
    expect(
      startContactStripeSync(
        logger(),
        onboardingEnv({ CONTACT_STRIPE_SYNC: "true", CONTACT_STRIPE_SYNC_INTERVAL_MS: "5" })
      )
    ).toBeNull();
    expect(
      startContactStripeSync(
        logger(),
        onboardingEnv({ CONTACT_STRIPE_SYNC: "true", NEXTCLOUD_BASE_URL: undefined })
      )
    ).toBeNull();
    expect(lines.filter((l) => l.level === "error")).toHaveLength(2);
    expect(
      await cycle(
        onboardingEnv({ CONTACT_STRIPE_SYNC: "true", CONTACT_STRIPE_SYNC_INTERVAL_MS: "x" })
      )
    ).toMatchObject({
      status: "invalid_config",
    });
  });

  it("does nothing, and never calls Nextcloud, when no card is linked", async () => {
    putCard(UID_A, BASE);
    expect(await cycle()).toMatchObject({ status: "ok", baselined: 0, pushed: 0 });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("baseline", () => {
  it("records hashes and the ETag on first sight and pushes nothing", async () => {
    await baselined();
    const state = await stateOf(UID_A);
    expect(state).toMatchObject({
      stripeCustomerId: "cus_dash",
      clientCode: "CP-003",
      lastError: null,
    });
    expect(state.baselineAt).toBeInstanceOf(Date);
    expect(state.etag).toMatch(/^"\d+"$/);
    expect(Object.keys(state.fieldHashes ?? {}).sort()).toEqual([
      "address",
      "email",
      "name",
      "phone",
    ]);
    // Hashes only, never the contact details.
    expect(JSON.stringify(state)).not.toMatch(/zephyrine|ophelia|555|Main St/i);
    expect(await tokenOf()).toMatch(/^http:\/\/sabre\.io\/ns\/sync\/\d+$/);
    expect(accounts).not.toHaveBeenCalled();
  });

  it("does not push the card's content over a hand-made Customer, then pushes later edits", async () => {
    await baselined();
    expect(await cycle()).toMatchObject({ status: "ok", pushed: 0, fullScan: false });
    putCard(UID_A, withBase(["TEL", "TEL;TYPE=WORK:+1 972 555 0100"]));
    expect(await cycle()).toMatchObject({ pushed: 1 });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("baselines a link made after the sync was already running, from the card itself", async () => {
    await baselined();
    await link(6, "CP-004", "cus_two");
    putCard(UID_B, BASE);
    // The new card was created before anyone edited it: it is in the delta and baselined.
    expect(await cycle()).toMatchObject({ baselined: 1, pushed: 0 });
    // An older card with a new link and no change since is still baselined (full scan).
    await db.delete(contactStripeSyncCards).where(eq(contactStripeSyncCards.contactUid, UID_B));
    expect(await cycle()).toMatchObject({ fullScan: true, baselined: 1, pushed: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it("resolves the link from billing_customers (backfill) before the submission's own column", async () => {
    await link(5, "CP-003", "cus_from_table");
    await db
      .update(clientOnboardingSubmissions)
      .set({ billingStatus: null, billingCustomerId: null });
    putCard(UID_A, BASE);
    expect(await cycle()).toMatchObject({ baselined: 1 });
    expect((await stateOf(UID_A)).stripeCustomerId).toBe("cus_from_table");
  });

  it("re-baselines without pushing when the card is linked to a different Customer", async () => {
    await baselined();
    await db
      .update(billingCustomers)
      .set({ stripeCustomerId: "cus_other" })
      .where(eq(billingCustomers.clientCode, "CP-003"));
    expect(await cycle()).toMatchObject({ fullScan: true, baselined: 1, pushed: 0 });
    expect((await stateOf(UID_A)).stripeCustomerId).toBe("cus_other");
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps a placeholder for a linked card that is not in the book instead of rescanning forever", async () => {
    await link(5, "CP-003", "cus_dash");
    expect(await cycle()).toMatchObject({ status: "ok", fullScan: true, baselined: 0 });
    expect(await cycle()).toMatchObject({ status: "ok", fullScan: false });
    // The card shows up later: baselined, not pushed.
    putCard(UID_A, BASE);
    expect(await cycle()).toMatchObject({ baselined: 1, pushed: 0 });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("sync-token delta and fallback", () => {
  it("asks only for what changed since the stored token", async () => {
    await baselined();
    const token = await tokenOf();
    const before = syncReports().length;
    putCard(UID_A, withBase(["EMAIL", "EMAIL;TYPE=WORK:new@zephyrine.example"]));
    const outcome = await cycle();
    expect(outcome).toMatchObject({ fullScan: false, pushed: 1 });
    const report = syncReports()[before];
    expect(report.body).toContain(token as string);
    expect(report.headers.depth).toBe("0");
    expect(await tokenOf()).not.toBe(token);
  });

  it("does not touch cards the delta does not list", async () => {
    await link(5, "CP-003", "cus_a");
    await link(6, "CP-004", "cus_b");
    putCard(UID_A, BASE);
    putCard(UID_B, BASE);
    expect(await cycle()).toMatchObject({ baselined: 2 });
    putCard(UID_A, withBase(["TEL", "TEL;TYPE=WORK:+1 972 555 0100"]));
    expect(await cycle()).toMatchObject({ pushed: 1, baselined: 0 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe("cus_a");
  });

  it("falls back to a full scan with an ETag compare when the token is refused, and resets the token", async () => {
    await link(5, "CP-003", "cus_a");
    await link(6, "CP-004", "cus_b");
    putCard(UID_A, BASE);
    putCard(UID_B, BASE);
    await cycle();
    const old = await tokenOf();
    fake.expireSyncTokens();
    putCard(UID_A, withBase(["EMAIL", "EMAIL;TYPE=WORK:new@zephyrine.example"]));
    const outcome = await cycle();
    expect(outcome).toMatchObject({ status: "ok", fullScan: true, pushed: 1 });
    // The unchanged card was seen again but its ETag matched: no push.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe("cus_a");
    const reports = syncReports();
    expect(reports.at(-2)?.body).toContain(old as string);
    expect(reports.at(-1)?.body).not.toContain("sabre.io");
    expect(await tokenOf()).not.toBe(old);
    expect(lines.some((l) => l.text.includes("sync-token rejected"))).toBe(true);
    // Back to deltas on the new token.
    expect(await cycle()).toMatchObject({ fullScan: false, pushed: 0 });
  });

  it("forgets a deleted card and baselines it again if it comes back", async () => {
    await baselined();
    fake.removeCard(`${UID_A}.vcf`);
    expect(await cycle()).toMatchObject({ status: "ok", pushed: 0 });
    expect((await stateOf(UID_A)).baselineAt).toBeNull();
    putCard(UID_A, withBase(["TEL", "TEL;TYPE=WORK:+1 972 555 0100"]));
    expect(await cycle()).toMatchObject({ baselined: 1, pushed: 0 });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("pushing edits", () => {
  it("pushes only the fields that changed, with an idempotency key and no stripeAccount", async () => {
    await baselined();
    putCard(UID_A, withBase(["EMAIL", "EMAIL;TYPE=WORK:new@zephyrine.example"]));
    expect(await cycle()).toMatchObject({ pushed: 1, failed: 0 });
    expect(update).toHaveBeenCalledTimes(1);
    const [customerId, params, options] = update.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(customerId).toBe("cus_dash");
    expect(params).toEqual({ email: "new@zephyrine.example" });
    expect(options.idempotencyKey).toMatch(/^contact-sync-[0-9a-f]{64}$/);
    expect(options).not.toHaveProperty("stripeAccount");
    expect(params).not.toHaveProperty("stripeAccount");
    const state = await stateOf(UID_A);
    expect(state.lastPushedAt).toBeInstanceOf(Date);
    expect(state.lastError).toBeNull();
    // Nothing written back to Nextcloud.
    expect(fake.writes()).toHaveLength(0);
    expect(accounts).not.toHaveBeenCalled();
    // Pushed once: the next cycle sees an unchanged ETag.
    expect(await cycle()).toMatchObject({ pushed: 0 });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("pushes name (ORG), phone and the mapped address", async () => {
    await baselined();
    putCard(
      UID_A,
      withBase(
        ["ORG", "ORG:Zephyrine Industries"],
        ["TEL", "TEL;TYPE=WORK:+1 972 555 0100"],
        ["ADR", "ADR;TYPE=WORK:PO Box 9;Suite 4;200 Elm St;Plano;Texas;75074;USA"]
      )
    );
    await cycle();
    expect(update.mock.calls[0][1]).toEqual({
      name: "Zephyrine Industries",
      phone: "+1 972 555 0100",
      address: {
        line1: "200 Elm St",
        line2: "Suite 4, PO Box 9",
        city: "Plano",
        state: "Texas",
        postal_code: "75074",
        country: "US",
      },
    });
  });

  it("falls back to FN for the name when the card has no ORG", async () => {
    await baselined();
    putCard(UID_A, withBase(["ORG", null], ["FN", "FN:Ophelia Q"]));
    await cycle();
    expect(update.mock.calls[0][1]).toEqual({ name: "Ophelia Q" });
  });

  it("does not push when only unmapped parts of the card changed", async () => {
    await baselined();
    putCard(UID_A, [...BASE, "NOTE:call after 3pm", "TITLE:Buyer"]);
    expect(await cycle()).toMatchObject({ pushed: 0, failed: 0 });
    expect(update).not.toHaveBeenCalled();
    expect((await stateOf(UID_A)).etag).toMatch(/"/);
  });

  it("never clears a Stripe field because the card field went blank", async () => {
    await baselined();
    putCard(UID_A, withBase(["TEL", null], ["ADR", null]));
    expect(await cycle()).toMatchObject({ pushed: 0 });
    expect(update).not.toHaveBeenCalled();
    // A later edit of another field pushes only that field.
    putCard(
      UID_A,
      withBase(["TEL", null], ["ADR", null], ["EMAIL", "EMAIL;TYPE=WORK:new@zephyrine.example"])
    );
    await cycle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1]).toEqual({ email: "new@zephyrine.example" });
  });

  it("leaves an ambiguous email unchanged and logs it without the value", async () => {
    await baselined();
    putCard(
      UID_A,
      withBase(["EMAIL", null], ["TEL", "TEL;TYPE=WORK:+1 972 555 0100"]).concat([
        "EMAIL;TYPE=WORK:one@zephyrine.example",
        "EMAIL;TYPE=HOME:two@zephyrine.example",
      ])
    );
    await cycle();
    expect(update.mock.calls[0][1]).toEqual({ phone: "+1 972 555 0100" });
    const note = lines.find((l) => l.text.includes("email_ambiguous"));
    expect(note?.level).toBe("warn");
    expect(note?.text).not.toMatch(/zephyrine\.example/);
  });
});

describe("scope", () => {
  it("ignores stripe-cus cards, unlinked client cards, other books and read-only books", async () => {
    await baselined();
    putCard("stripe-cus_ABC123", withBase(["EMAIL", "EMAIL:s@zephyrine.example"]));
    putCard(`dfwsc-client-${ONB_FORM_ID}-99`, BASE); // no submission, no link
    fake.addBook("other");
    fake.addCardTo("other", `${UID_A}.vcf`, vcard(UID_A, withBase(["TEL", "TEL:+1 999 555 0000"])));
    expect(await cycle()).toMatchObject({ status: "ok", baselined: 0, pushed: 0 });
    expect(update).not.toHaveBeenCalled();
    const rows = await db.select().from(contactStripeSyncCards);
    expect(rows.map((r) => r.contactUid)).toEqual([UID_A]);

    // A link whose submission matched somebody else's card (not ours) is not synced.
    await db.insert(clientOnboardingSubmissions).values({
      formId: ONB_FORM_ID,
      submissionId: 7,
      contactStatus: "updated",
      contactUid: "someone-elses-uid",
      projectCode: "CP-007",
      billingStatus: "linked",
      billingCustomerId: "cus_seven",
    });
    expect(await cycle()).toMatchObject({ status: "ok", baselined: 0 });
  });

  it("skips the whole cycle, with one log, when the onboarding book is read-only", async () => {
    await link(5, "CP-003", "cus_dash");
    const readOnlyBook = "ro-book";
    fake.addBook(readOnlyBook, true);
    const env = onboardingEnv({
      CONTACT_STRIPE_SYNC: "true",
      CLIENT_ONBOARDING_ADDRESSBOOK_PATH: readOnlyBook,
    });
    fake.addCardTo(readOnlyBook, `${UID_A}.vcf`, vcard(UID_A, BASE));
    expect(await cycle(env)).toMatchObject({ status: "read_only" });
    expect(await cycle(env)).toMatchObject({ status: "read_only" });
    expect(lines.filter((l) => l.text.includes("read-only"))).toHaveLength(1);
    expect(syncReports()).toHaveLength(0);
  });
});

describe("cards sharing one Customer", () => {
  it.each([
    ["listed oldest first", "20261101T110000Z", "20261101T120000Z"],
    ["listed newest first", "20261101T120000Z", "20261101T110000Z"],
  ])("applies the changes in REV order, last change wins (%s)", async (_label, revA, revB) => {
    await link(5, "CP-003", "cus_shared");
    await link(6, "CP-004", "cus_shared");
    putCard(UID_A, BASE);
    putCard(UID_B, BASE);
    expect(await cycle()).toMatchObject({ baselined: 2 });
    putCard(UID_A, withBase(["EMAIL", "EMAIL;TYPE=WORK:from-a@zephyrine.example"]), revA);
    putCard(UID_B, withBase(["EMAIL", "EMAIL;TYPE=WORK:from-b@zephyrine.example"]), revB);
    expect(await cycle()).toMatchObject({ pushed: 2 });
    const emails = update.mock.calls.map((c) => (c[1] as { email: string }).email);
    expect(emails).toEqual(
      revA < revB
        ? ["from-a@zephyrine.example", "from-b@zephyrine.example"]
        : ["from-b@zephyrine.example", "from-a@zephyrine.example"]
    );
    expect(update.mock.calls.every((c) => c[0] === "cus_shared")).toBe(true);
    const note = lines.find((l) => l.text.includes("REV order"));
    expect(note?.text).toContain("cus_shared");
    expect(note?.text).not.toMatch(/zephyrine\.example/);
  });
});

describe("errors", () => {
  it.each([
    ["connection", new Stripe.errors.StripeConnectionError({ message: "down" } as never)],
    [
      "rate limit",
      new Stripe.errors.StripeRateLimitError({ message: "slow", statusCode: 429 } as never),
    ],
    ["5xx", new Stripe.errors.StripeAPIError({ message: "oops", statusCode: 500 } as never)],
    [
      "401",
      new Stripe.errors.StripeAuthenticationError({ message: "key", statusCode: 401 } as never),
    ],
    ["403", new Stripe.errors.StripePermissionError({ message: "no", statusCode: 403 } as never)],
  ])("retries next cycle after a retryable error (%s) and keeps the token", async (_label, error) => {
    await baselined();
    const token = await tokenOf();
    update.mockRejectedValueOnce(error);
    putCard(UID_A, withBase(["EMAIL", "EMAIL;TYPE=WORK:new@zephyrine.example"]));
    expect(await cycle()).toMatchObject({ status: "ok", pushed: 0, failed: 1 });
    expect(await tokenOf()).toBe(token);
    const failed = await stateOf(UID_A);
    expect(failed.lastError).toMatch(/^stripe\.customer_update:/);
    expect(failed.lastErrorHash).toBeNull();
    // Same delta again, the push now succeeds.
    expect(await cycle()).toMatchObject({ pushed: 1, failed: 0 });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][1]).toEqual({ email: "new@zephyrine.example" });
    expect(update.mock.calls[1][2]).toEqual(update.mock.calls[0][2]); // same idempotency key
    expect((await stateOf(UID_A)).lastError).toBeNull();
    expect(await tokenOf()).not.toBe(token);
  });

  it("stores a non-retryable error and retries only after the card changes again", async () => {
    await baselined();
    update.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({ message: "bad", statusCode: 400 } as never)
    );
    putCard(UID_A, withBase(["EMAIL", "EMAIL;TYPE=WORK:new@zephyrine.example"]));
    expect(await cycle()).toMatchObject({ pushed: 0, failed: 1 });
    const failed = await stateOf(UID_A);
    expect(failed).toMatchObject({ lastError: "stripe.customer_update:400" });
    expect(failed.lastErrorHash).not.toBeNull();
    // The token moved on: the failed card is not looked at again.
    expect(await cycle()).toMatchObject({ failed: 0, pushed: 0 });
    // A full scan sees the same content (same ETag): still no retry.
    fake.expireSyncTokens();
    expect(await cycle()).toMatchObject({ fullScan: true, failed: 0, pushed: 0 });
    expect(update).toHaveBeenCalledTimes(1);
    // An edit that changes the content retries.
    putCard(UID_A, withBase(["EMAIL", "EMAIL;TYPE=WORK:fixed@zephyrine.example"]));
    expect(await cycle()).toMatchObject({ pushed: 1 });
    expect(update).toHaveBeenCalledTimes(2);
    expect((await stateOf(UID_A)).lastError).toBeNull();
  });

  it("holds the later cards of a Customer when an earlier one failed retryably", async () => {
    await link(5, "CP-003", "cus_shared");
    await link(6, "CP-004", "cus_shared");
    putCard(UID_A, BASE);
    putCard(UID_B, BASE);
    await cycle();
    putCard(UID_A, withBase(["TEL", "TEL:+1 111 555 0000"]), "20261101T110000Z");
    putCard(UID_B, withBase(["TEL", "TEL:+1 222 555 0000"]), "20261101T120000Z");
    update.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: "x" } as never)
    );
    expect(await cycle()).toMatchObject({ pushed: 0, failed: 1 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(await cycle()).toMatchObject({ pushed: 2 });
    expect(update.mock.calls.slice(1).map((c) => (c[1] as { phone: string }).phone)).toEqual([
      "+1 111 555 0000",
      "+1 222 555 0000",
    ]);
  });

  it("reports Nextcloud being down without failing or losing state", async () => {
    await baselined();
    fake.fail({ match: () => true, status: 503, times: 10 });
    expect(await cycle()).toMatchObject({ status: "nextcloud_unavailable" });
    expect(update).not.toHaveBeenCalled();
  });

  it("logs no names, emails, phone numbers, addresses or paths", async () => {
    await baselined();
    putCard(
      UID_A,
      withBase(
        ["EMAIL", "EMAIL;TYPE=WORK:new@zephyrine.example"],
        ["ADR", "ADR:;;1 Nowhere Rd;Plano;TX;75074;Narnia"]
      )
    );
    update.mockRejectedValueOnce(
      new Stripe.errors.StripeAPIError({
        message: "oops new@zephyrine.example",
        statusCode: 500,
      } as never)
    );
    await cycle();
    await cycle();
    const all = lines.map((l) => l.text).join("\n");
    expect(all).not.toMatch(
      /zephyrine|ophelia|quartermaine|555|Main St|Nowhere|Plano|Narnia|remote\.php|\.vcf/i
    );
    expect(all).toContain("country_unmappable");
  });
});

describe("label rules (mapCardToStripe)", () => {
  const map = (body: string[]) => mapCardToStripe(vcard("u", body));

  it("email: the entry labelled Account email wins, whatever the case or label format", () => {
    const grouped = map([
      "EMAIL;TYPE=WORK:contact@x.example",
      "item1.EMAIL:ap@x.example",
      "item1.X-ABLabel:account EMAIL",
    ]);
    expect(grouped.fields.email).toBe("ap@x.example");
    const typed = map(["EMAIL:contact@x.example", 'EMAIL;TYPE="Account email":ap@x.example']);
    expect(typed.fields.email).toBe("ap@x.example");
    const apple = map([
      "EMAIL:contact@x.example",
      "item2.EMAIL:ap@x.example",
      "item2.X-ABLabel:_$!<Account email>!$_",
    ]);
    expect(apple.fields.email).toBe("ap@x.example");
  });

  it("email: the only entry is used, several unlabelled ones leave it unchanged", () => {
    expect(map(["EMAIL:only@x.example"]).fields.email).toBe("only@x.example");
    const two = map(["EMAIL:a@x.example", "EMAIL:b@x.example"]);
    expect(two.fields.email).toBeUndefined();
    expect(two.notes).toContain("email_ambiguous");
    expect(
      map(["EMAIL:a@x.example", "EMAIL;TYPE=HOME:A@x.example"]).fields.email?.toLowerCase()
    ).toBe("a@x.example");
    expect(map(["EMAIL:not an email"]).notes).toContain("email_invalid");
    expect(map(["EMAIL:"]).fields.email).toBeUndefined();
  });

  it("phone: Account phone label, else the only TEL, else unchanged", () => {
    expect(map(["TEL:111", "item1.TEL:222", "item1.X-ABLabel:Account phone"]).fields.phone).toBe(
      "222"
    );
    expect(map(["TEL;TYPE=CELL:333"]).fields.phone).toBe("333");
    const two = map(["TEL:111", "TEL:222"]);
    expect(two.fields.phone).toBeUndefined();
    expect(two.notes).toContain("phone_ambiguous");
  });

  it("address: Billing address label, else the only ADR, else unchanged; maps the components", () => {
    const labelled = map([
      "ADR:;;1 Home St;Home;TX;75001;US",
      "item1.ADR:;Ste 2;9 Bill Rd;Billville;CA;90210;United States",
      "item1.X-ABLabel:Billing address",
    ]);
    expect(labelled.fields.address).toEqual({
      line1: "9 Bill Rd",
      line2: "Ste 2",
      city: "Billville",
      state: "CA",
      postal_code: "90210",
      country: "US",
    });
    expect(map(["ADR:;;1 Only St;Town;;;"]).fields.address).toEqual({
      line1: "1 Only St",
      city: "Town",
    });
    const two = map(["ADR:;;1 A St;;;;", "ADR:;;2 B St;;;;"]);
    expect(two.fields.address).toBeUndefined();
    expect(two.notes).toContain("address_ambiguous");
    expect(map(["ADR:;;;;;;"]).fields.address).toBeUndefined();
  });

  it("name: ORG, else FN, else nothing", () => {
    expect(map(["FN:A Person", "ORG:Acme\\, Inc.;Dept"]).fields.name).toBe("Acme, Inc.");
    expect(map(["FN:A Person"]).fields.name).toBe("A Person");
    expect(map(["EMAIL:a@x.example"]).fields.name).toBeUndefined();
  });

  it("reads REV in basic and extended formats", () => {
    expect(mapCardToStripe(vcard("u", [], "20261101T120000Z")).rev).toBe(Date.UTC(2026, 10, 1, 12));
    expect(mapCardToStripe(vcard("u", [], "2026-11-01T12:00:00Z")).rev).toBe(
      Date.UTC(2026, 10, 1, 12)
    );
    expect(mapCardToStripe("BEGIN:VCARD\r\nEND:VCARD\r\n").rev).toBeNull();
  });
});

describe("country mapping", () => {
  it.each([
    ["United States", "US"],
    ["USA", "US"],
    ["U.S.A.", "US"],
    ["us", "US"],
    ["United States of America", "US"],
    ["United Kingdom", "GB"],
    ["UK", "GB"],
    ["Canada", "CA"],
    ["Mexico", "MX"],
    ["Germany", "DE"],
    ["de", "DE"],
    ["  france ", "FR"],
  ])("%s -> %s", (input, expected) => {
    expect(countryCode(input)).toBe(expected);
  });

  it.each(["Narnia", "", "ZZ", "XX"])("leaves %j unmappable", (input) => {
    expect(countryCode(input)).toBeUndefined();
  });

  it("omits an unmappable country but keeps the rest of the address", () => {
    const mapped = mapCardToStripe(vcard("u", ["ADR:;;1 A St;Town;TX;75001;Narnia"]));
    expect(mapped.fields.address).toEqual({
      line1: "1 A St",
      city: "Town",
      state: "TX",
      postal_code: "75001",
    });
    expect(mapped.notes).toContain("country_unmappable");
  });
});

describe("onboarding contact step writes the Account email", () => {
  const ONBOARDING = onboardingEnv({ CONTACT_STRIPE_SYNC: "true" });
  const FULL = {
    company: "Zephyrine Widgets LLC",
    contact_name: "Ophelia Quartermaine",
    email: "Ophelia@Zephyrine.example",
    phone: "+1 214 555 0199",
    project_name: "Warehouse Portal",
    start_date: "2026-11-02",
    target_date: "2027-01-29",
    summary: "Build the warehouse portal MVP",
    lead_link: "https://cloud.test/apps/tables/#/table/8/row/301",
  };

  async function onboard(answers: Record<string, string>) {
    fake.addLead(301, "Zephyrine Widgets LLC");
    fake.questions.push({ ...BILLING_EMAIL_QUESTION });
    const run = () => runClientOnboardingCycle({ logger: logger(), env: ONBOARDING });
    expect((await run()).status).toBe("ok");
    fake.addSubmission(5, { ...FULL, ...answers });
    return run();
  }

  it("labels a valid billing email on the new card, in the format the sync reads", async () => {
    vi.spyOn(stripe.customers, "list").mockResolvedValue({ data: [] } as never);
    vi.spyOn(stripe.customers, "create").mockResolvedValue({ id: "cus_new" } as never);
    expect(await onboard({ billing_email: "AP@Zephyrine.example" })).toMatchObject({
      completed: 1,
    });
    const card =
      [...fake.cards.values()].find((c) => c.data.includes("UID:dfwsc-client-"))?.data ?? "";
    expect(card).toContain("item1.X-ABLabel:Account email");
    const mapped = mapCardToStripe(card);
    expect(mapped.fields.email).toBe("AP@Zephyrine.example");
    expect(card).toContain("EMAIL;TYPE=WORK:Ophelia@Zephyrine.example");
    expect(accounts).not.toHaveBeenCalled();
  });

  it("writes no label without a valid billing email", async () => {
    vi.spyOn(stripe.customers, "list").mockResolvedValue({ data: [] } as never);
    vi.spyOn(stripe.customers, "create").mockResolvedValue({ id: "cus_new" } as never);
    expect(await onboard({ billing_email: "not an email" })).toMatchObject({ completed: 1 });
    const card =
      [...fake.cards.values()].find((c) => c.data.includes("UID:dfwsc-client-"))?.data ?? "";
    expect(card).not.toContain("X-ABLabel");
  });

  it("keeps one entry when the billing email is the contact email", async () => {
    expect(await onboard({ billing_email: "ophelia@zephyrine.example" })).toMatchObject({
      completed: 1,
    });
    const card =
      [...fake.cards.values()].find((c) => c.data.includes("UID:dfwsc-client-"))?.data ?? "";
    expect(card.match(/EMAIL/g)).toHaveLength(1);
    expect(mapCardToStripe(card).fields.email).toBe("ophelia@zephyrine.example");
  });

  it("adds the label to a matched card additively, and leaves an existing label alone", async () => {
    fake.addCard(
      "existing.vcf",
      vcard("someone-else", [
        "FN:Ophelia Quartermaine",
        "ORG:Other Co",
        "EMAIL;TYPE=WORK:ophelia@zephyrine.example",
      ])
    );
    expect(await onboard({ billing_email: "ap@zephyrine.example" })).toMatchObject({
      completed: 1,
    });
    const merged = fake.cards.get("existing.vcf")?.data ?? "";
    expect(merged).toContain("ORG:Other Co");
    expect(merged).toContain("ophelia@zephyrine.example");
    expect(mapCardToStripe(merged).fields.email).toBe("ap@zephyrine.example");

    // Already labelled by someone: not overwritten, not duplicated.
    const labelled = vcard("keeper", [
      "FN:Keeper",
      "ORG:Keep Co",
      "EMAIL:ophelia@zephyrine.example",
      "item1.EMAIL:mine@zephyrine.example",
      "item1.X-ABLabel:Account email",
    ]);
    fake.cards.clear();
    fake.addCard("keeper.vcf", labelled);
    await db.delete(clientOnboardingSubmissions);
    await db.delete(clientOnboardingSyncState);
    fake.submissions.clear();
    fake.addSubmission(8, { ...FULL, billing_email: "other@zephyrine.example" });
    await runClientOnboardingCycle({ logger: logger(), env: ONBOARDING });
    const kept = fake.cards.get("keeper.vcf")?.data ?? "";
    expect(kept.match(/X-ABLabel/g)).toHaveLength(1);
    expect(mapCardToStripe(kept).fields.email).toBe("mine@zephyrine.example");
  });
});
