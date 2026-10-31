import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import { billingCustomers, clientOnboardingSubmissions } from "../../db/schema";
import { findExistingBillingCustomer } from "../../lib/billing-customer";
import { stripe } from "../../lib/stripe";
import { describeFailure, helpText, parseCsv, run } from "../../scripts/backfill-billing-customers";

let lines: string[];
let list: ReturnType<typeof vi.spyOn>;
let create: ReturnType<typeof vi.spyOn>;
let retrieve: ReturnType<typeof vi.spyOn>;

const customerList = (...ids: string[]) =>
  ({ data: ids.map((id) => ({ id })) }) as unknown as Stripe.Response<
    Stripe.ApiList<Stripe.Customer>
  >;

async function seed(code: string, number: number, folderName: string | null) {
  await db.insert(clientOnboardingSubmissions).values({
    formId: 1,
    submissionId: number,
    status: "completed",
    projectCode: code,
    projectNumber: number,
    folderName,
  });
}

const csv = (text: string) => ({ readStdin: () => text });

beforeEach(async () => {
  await db.delete(clientOnboardingSubmissions);
  await db.delete(billingCustomers);
  lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  vi.spyOn(stripe.accounts, "retrieve").mockResolvedValue({ id: "acct_plat" } as never);
  list = vi.spyOn(stripe.customers, "list").mockResolvedValue(customerList());
  create = vi
    .spyOn(stripe.customers, "create")
    .mockResolvedValue({ id: "cus_new" } as unknown as Stripe.Response<Stripe.Customer>);
  retrieve = vi
    .spyOn(stripe.customers, "retrieve")
    .mockResolvedValue({ id: "cus_pin" } as unknown as Stripe.Response<Stripe.Customer>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const output = () => lines.join("\n");

describe("backfill script: arguments", () => {
  it("prints help and exits 0 without touching Stripe or the database", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(output()).toContain("--csv <file>");
    expect(output()).toContain("dist/scripts/backfill-billing-customers.js");
    expect(helpText()).toContain('"-"');
    expect(list).not.toHaveBeenCalled();
  });

  it("exits non-zero with a hint when stdin has no CSV rows", async () => {
    expect(await run(["--csv", "-"], csv(" \n"))).toBe(1);
    expect(output()).toContain("no CSV rows on stdin; did you pass -i to docker exec?");
    expect(list).not.toHaveBeenCalled();
  });

  it("reads the CSV from the process stdin stream by default", async () => {
    const { Readable } = await import("node:stream");
    const stream = Readable.from([Buffer.from("CP-004,a@b.co\n"), Buffer.from("CP-005,c@d.co\n")]);
    const spy = vi.spyOn(process, "stdin", "get").mockReturnValue(stream as never);
    await seed("CP-004", 4, "Folder");
    expect(await run(["--csv", "-"])).toBe(0);
    expect(output()).toContain("CP-004: would create a Customer");
    spy.mockRestore();
  });

  it("prints help and exits 1 when --csv is missing", async () => {
    expect(await run([])).toBe(1);
    expect(output()).toContain("Usage:");
  });

  it("parses the CSV: header, blanks, case and optional columns", () => {
    const entries = parseCsv("client_code,email\r\ncp-004, a@b.co ,Acme,cus_1\n\nCP-005,c@d.co\n");
    expect([...entries.keys()]).toEqual(["CP-004", "CP-005"]);
    expect(entries.get("CP-004")).toEqual({
      email: "a@b.co",
      company: "Acme",
      stripeCustomerId: "cus_1",
    });
    expect(entries.get("CP-005")).toEqual({ email: "c@d.co" });
  });
});

describe("backfill script: dry run and apply", () => {
  it("reads the CSV from stdin, writes nothing on a dry run, and notes the folder-name fallback", async () => {
    await seed("CP-004", 4, "Emmut Folder");
    expect(await run(["--csv", "-"], csv("CP-004,ap@emmut.example"))).toBe(0);
    expect(output()).toContain("DRY RUN");
    expect(output()).toContain(
      'CP-004: note: no company in the CSV, using the folder name "Emmut Folder"'
    );
    expect(output()).toContain("CP-004: would create a Customer");
    expect(create).not.toHaveBeenCalled();
    expect(await db.select().from(billingCustomers)).toHaveLength(0);
  });

  it("falls back to the client code when there is no folder name either", async () => {
    await seed("CP-004", 4, null);
    await run(["--csv", "-"], csv("CP-004,ap@emmut.example"));
    expect(output()).toContain('using the client code "CP-004"');
  });

  it("creates and links with --apply, using the CSV company without a note", async () => {
    await seed("CP-004", 4, "Folder");
    expect(await run(["--csv", "-", "--apply"], csv("CP-004,ap@emmut.example,Emmut Corp"))).toBe(0);
    expect(output()).not.toContain("note:");
    expect(output()).toContain("CP-004: created cus_new");
    expect((create.mock.calls[0][0] as { name: string }).name).toBe("Emmut Corp");
    const [sub] = await db
      .select()
      .from(clientOnboardingSubmissions)
      .where(eq(clientOnboardingSubmissions.projectCode, "CP-004"));
    expect(sub).toMatchObject({ billingStatus: "linked", billingCustomerId: "cus_new" });
  });

  it("looks up an existing Customer read-only, the lookup the dry run relies on", async () => {
    list.mockResolvedValue(customerList("cus_x"));
    expect(
      await findExistingBillingCustomer({ clientCode: "CP-009", email: "x@y.example" })
    ).toEqual({ kind: "stripe", stripeCustomerId: "cus_x" });
    expect(create).not.toHaveBeenCalled();
    expect(await db.select().from(billingCustomers)).toHaveLength(0);
  });

  it("gives invalid_email its own message, not the several-Customers one", async () => {
    await seed("CP-004", 4, "Folder");
    create.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "Invalid email address",
        param: "email",
      } as never)
    );
    expect(await run(["--csv", "-", "--apply"], csv("CP-004,ap@emmut.example,Emmut"))).toBe(0);
    expect(output()).toContain("invalid_email (Stripe rejected the email address");
    expect(output()).not.toContain("several Customers");
    expect(output()).toContain('"invalidEmail":1');
  });

  it("reports several matches as ambiguous", async () => {
    await seed("CP-004", 4, "Folder");
    list.mockResolvedValue(customerList("cus_a", "cus_b"));
    await run(["--csv", "-", "--apply"], csv("CP-004,ap@emmut.example,Emmut"));
    expect(output()).toContain("ambiguous (several Customers share the email");
  });

  it("skips codes missing from the CSV and invalid CSV emails", async () => {
    await seed("CP-004", 4, "Folder");
    await seed("CP-005", 5, "Folder");
    await run(["--csv", "-"], csv("CP-005,not-an-email"));
    expect(output()).toContain("CP-004: skipped (not in the CSV)");
    expect(output()).toContain("CP-005: skipped (the CSV email is not a valid address)");
  });
});

describe("backfill script: pinned Customer in a dry run", () => {
  const pinned = "CP-004,ap@emmut.example,Emmut,cus_pin";

  it("would link an existing pinned Customer", async () => {
    await seed("CP-004", 4, "Folder");
    expect(await run(["--csv", "-"], csv(pinned))).toBe(0);
    expect(output()).toContain("CP-004: would link cus_pin");
  });

  it("reports a deleted Customer", async () => {
    await seed("CP-004", 4, "Folder");
    retrieve.mockResolvedValue({ id: "cus_pin", deleted: true } as never);
    expect(await run(["--csv", "-"], csv(pinned))).toBe(1);
    expect(output()).toContain("is deleted in Stripe");
  });

  it("reports a missing Customer", async () => {
    await seed("CP-004", 4, "Folder");
    retrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "No such customer",
        code: "resource_missing",
        statusCode: 404,
      } as never)
    );
    expect(await run(["--csv", "-"], csv(pinned))).toBe(1);
    expect(output()).toContain("does not exist in Stripe");
  });

  it("reports an auth failure and a network failure distinctly", async () => {
    await seed("CP-004", 4, "Folder");
    retrieve.mockRejectedValueOnce(
      new Stripe.errors.StripeAuthenticationError({
        type: "authentication_error",
        message: "Invalid API Key",
        statusCode: 401,
      } as never)
    );
    await run(["--csv", "-"], csv(pinned));
    expect(output()).toContain("Stripe refused the key");
    retrieve.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({
        type: "api_error",
        message: "socket hang up",
      } as never)
    );
    await run(["--csv", "-"], csv(pinned));
    expect(output()).toContain("unreachable or busy");
  });

  it("reports a network failure on a pinned Customer under --apply as unreachable", async () => {
    await seed("CP-004", 4, "Folder");
    retrieve.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({
        type: "api_error",
        message: "socket hang up",
      } as never)
    );
    expect(await run(["--csv", "-", "--apply"], csv(pinned))).toBe(1);
    expect(output()).toContain("unreachable or busy");
    expect(output()).not.toContain("Stripe error");
  });

  it("describes unknown errors without leaking details", () => {
    expect(describeFailure(new Error("boom with pii"))).toBe("unexpected error");
    expect(
      describeFailure(new Stripe.errors.StripeAPIError({ type: "api_error" } as never))
    ).toContain("unreachable or busy");
    expect(
      describeFailure(
        new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error" } as never)
      )
    ).toContain("Stripe error");
  });
});
