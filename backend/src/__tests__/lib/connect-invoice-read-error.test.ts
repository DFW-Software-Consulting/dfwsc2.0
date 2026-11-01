import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { classifyInvoiceReadError } from "../../lib/connect-invoice-sync";

const stripeErr = (
  Ctor: new (raw: never) => Error,
  statusCode: number,
  extra: Record<string, unknown> = {}
) => new Ctor({ type: "x", statusCode, ...extra } as never);

describe("classifyInvoiceReadError", () => {
  const cases: Array<[string, unknown, "missing" | "ack" | "retry"]> = [
    ["404", stripeErr(Stripe.errors.StripeInvalidRequestError, 404), "missing"],
    [
      "resource_missing without a status",
      stripeErr(Stripe.errors.StripeInvalidRequestError, 400, { code: "resource_missing" }),
      "missing",
    ],
    ["400 invalid request", stripeErr(Stripe.errors.StripeInvalidRequestError, 400), "ack"],
    [
      "400 with an unrelated code",
      stripeErr(Stripe.errors.StripeInvalidRequestError, 400, { code: "parameter_invalid_empty" }),
      "ack",
    ],
    ["401 bad or rotated key", stripeErr(Stripe.errors.StripeAuthenticationError, 401), "retry"],
    ["403 permission", stripeErr(Stripe.errors.StripePermissionError, 403), "retry"],
    [
      "400 permission type",
      stripeErr(Stripe.errors.StripePermissionError, 400, { type: "StripePermissionError" }),
      "retry",
    ],
    [
      "400 api_key code",
      stripeErr(Stripe.errors.StripeInvalidRequestError, 400, { code: "api_key_expired" }),
      "retry",
    ],
    ["409 lock", stripeErr(Stripe.errors.StripeInvalidRequestError, 409), "retry"],
    ["429", stripeErr(Stripe.errors.StripeRateLimitError, 429), "retry"],
    ["500", stripeErr(Stripe.errors.StripeAPIError, 500), "retry"],
    ["503", stripeErr(Stripe.errors.StripeAPIError, 503), "retry"],
    ["connection error (no status)", new Error("ECONNRESET"), "retry"],
    ["null", null, "retry"],
  ];
  it.each(cases)("%s", (_name, err, expected) => {
    expect(classifyInvoiceReadError(err)).toBe(expected);
  });
});
