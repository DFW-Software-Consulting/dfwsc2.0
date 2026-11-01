import { describe, expect, it } from "vitest";
import {
  dbErrorFields,
  errorLogFields,
  retryErrorFields,
  transportErrorFields,
} from "../../lib/safe-error-log";

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
    // The return type is a union over the error kinds; an application error carries the extra fields.
    const fields = retryErrorFields(new Error("boom")) as Record<string, unknown>;
    expect(fields.errMessage).toBe("boom");
    expect(fields.errStack).toContain("boom");
  });

  it("emits only name and code for a non-DB, non-Stripe error", () => {
    const e = Object.assign(new TypeError(`cannot read ${EMAIL}`), { code: "ERR_X" });
    const fields = dbErrorFields(e);
    expect(fields.errName).toBe("TypeError");
    expect(fields.errCode).toBe("ERR_X");
    expect(JSON.stringify(fields)).not.toContain(EMAIL);
  });

  describe("errorLogFields", () => {
    it("keeps identifiers only for a Stripe error", () => {
      const e = Object.assign(new Error(`No such customer ${EMAIL}`), {
        type: "StripeInvalidRequestError",
        code: "resource_missing",
      });
      expect(errorLogFields(e)).toMatchObject({ errCode: "resource_missing" });
      expect(JSON.stringify(errorLogFields(e))).not.toContain(EMAIL);
    });

    it("keeps SQLSTATE and schema names only for a Drizzle error", () => {
      const fields = errorLogFields(drizzleError());
      expect(fields).toMatchObject({ errCode: "23505", errConstraint: "uq_email" });
      expect(JSON.stringify(fields)).not.toContain(EMAIL);
    });

    it("keeps message and stack for our own bug", () => {
      expect(errorLogFields(new Error("boom"))).toMatchObject({ errMessage: "boom" });
    });
  });

  describe("transportErrorFields", () => {
    it("keeps nodemailer identifiers and never the message or response text", () => {
      const e = Object.assign(new Error(`Recipient address rejected: ${EMAIL}`), {
        code: "EENVELOPE",
        responseCode: 550,
        command: "RCPT TO",
        response: `550 <${EMAIL}> unknown`,
      });
      expect(transportErrorFields(e)).toEqual({
        errName: "Error",
        errCode: "EENVELOPE",
        errResponseCode: 550,
        errCommand: "RCPT TO",
        errStatus: undefined,
      });
      expect(JSON.stringify(transportErrorFields(e))).not.toContain(EMAIL);
    });

    it("keeps the HTTP status of a Nextcloud client error", () => {
      const e = Object.assign(new Error(`body ${EMAIL}`), {
        name: "NextcloudHttpError",
        status: 502,
      });
      expect(transportErrorFields(e)).toMatchObject({
        errName: "NextcloudHttpError",
        errStatus: 502,
      });
    });

    it("drops values of the wrong type and tolerates non-errors", () => {
      expect(
        transportErrorFields({ code: { x: 1 }, responseCode: "550", command: 5, status: "500" })
      ).toEqual({
        errName: undefined,
        errCode: undefined,
        errResponseCode: undefined,
        errCommand: undefined,
        errStatus: undefined,
      });
      expect(transportErrorFields(null).errName).toBeUndefined();
    });
  });
});
