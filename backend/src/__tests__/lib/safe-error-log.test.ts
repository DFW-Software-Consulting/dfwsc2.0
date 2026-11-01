import { describe, expect, it } from "vitest";
import { dbErrorFields, retryErrorFields } from "../../lib/safe-error-log";

const URL_SECRET = "https://invoice.stripe.com/i/acct_1/live_secret";
const EMAIL = "jane@customer.example";

function drizzleError(code = "23505") {
  const pg = Object.assign(new Error(`duplicate key value (${EMAIL})`), {
    code,
    severity: "ERROR",
    detail: `Key (email)=(${EMAIL}) already exists.`,
    constraint: "uq_email",
    table: "connect_invoices",
    column: "email",
    routine: "_bt_check_unique",
  });
  const err = new Error(`Failed query: insert into x params: ${URL_SECRET},${EMAIL}`, {
    cause: pg,
  });
  err.name = "DrizzleQueryError";
  return err;
}

describe("safe-error-log", () => {
  it("keeps only SQLSTATE and schema names for a Drizzle-wrapped pg error", () => {
    const fields = retryErrorFields(drizzleError());
    expect(fields).toEqual({
      errName: "DrizzleQueryError",
      errCode: "23505",
      errConstraint: "uq_email",
      errTable: "connect_invoices",
      errColumn: "email",
      errRoutine: "_bt_check_unique",
    });
    const dumped = JSON.stringify(fields);
    expect(dumped).not.toContain(EMAIL);
    expect(dumped).not.toContain(URL_SECRET);
  });

  it("reads a bare pg-shaped error without severity or routine", () => {
    const e = Object.assign(new Error(`dup ${EMAIL}`), {
      code: "23505",
      detail: EMAIL,
      constraint: "uq_x",
    });
    const fields = dbErrorFields(e);
    expect(fields.errCode).toBe("23505");
    expect(fields.errConstraint).toBe("uq_x");
    expect(JSON.stringify(fields)).not.toContain(EMAIL);
  });

  it("keeps only identifiers for a Stripe error", () => {
    const e = Object.assign(new Error(`No such customer ${EMAIL}`), {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      statusCode: 404,
      requestId: "req_1",
    });
    expect(retryErrorFields(e)).toEqual({
      errType: "StripeInvalidRequestError",
      errCode: "resource_missing",
      errStatusCode: 404,
      errRequestId: "req_1",
    });
    expect(JSON.stringify(retryErrorFields(e))).not.toContain(EMAIL);
  });

  it("keeps message and stack for an application error", () => {
    const fields = retryErrorFields(new Error("boom"));
    expect(fields.errMessage).toBe("boom");
    expect(fields.errStack).toContain("boom");
  });
});
