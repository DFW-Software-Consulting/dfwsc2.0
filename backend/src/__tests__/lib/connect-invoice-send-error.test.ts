import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { classifySendError } from "../../lib/connect-invoice";

const E = Stripe.errors;

describe("classifySendError", () => {
  it.each([
    [
      "invalid request 400",
      new E.StripeInvalidRequestError({ type: "invalid_request_error", statusCode: 400 } as never),
      "rejected",
    ],
    [
      "invalid request 404",
      new E.StripeInvalidRequestError({ type: "invalid_request_error", statusCode: 404 } as never),
      "rejected",
    ],
    [
      "permission 403",
      new E.StripePermissionError({ type: "invalid_request_error", statusCode: 403 } as never),
      "rejected",
    ],
    [
      "authentication 401",
      new E.StripeAuthenticationError({ type: "authentication_error", statusCode: 401 } as never),
      "rejected",
    ],
    [
      "card 402",
      new E.StripeCardError({ type: "card_error", statusCode: 402 } as never),
      "rejected",
    ],
    [
      "idempotency mismatch 400",
      new E.StripeIdempotencyError({ type: "idempotency_error", statusCode: 400 } as never),
      "rejected",
    ],
    [
      "idempotency in progress 409",
      new E.StripeIdempotencyError({ type: "idempotency_error", statusCode: 409 } as never),
      "in_progress",
    ],
    [
      "lock timeout 409",
      new E.StripeInvalidRequestError({ type: "invalid_request_error", statusCode: 409 } as never),
      "in_progress",
    ],
    [
      "key in use by code",
      Object.assign(new Error("x"), { code: "idempotency_key_in_use", statusCode: 400 }),
      "in_progress",
    ],
    [
      "rate limit 429",
      new E.StripeRateLimitError({ type: "rate_limit_error", statusCode: 429 } as never),
      "unknown",
    ],
    [
      "api error 500",
      new E.StripeAPIError({ type: "api_error", statusCode: 500 } as never),
      "unknown",
    ],
    [
      "api error 503",
      new E.StripeAPIError({ type: "api_error", statusCode: 503 } as never),
      "unknown",
    ],
    ["connection error", new E.StripeConnectionError({ type: "api_error" } as never), "unknown"],
    ["plain error (circuit open, timeout)", new Error("Circuit open"), "unknown"],
    ["null", null, "unknown"],
  ])("%s -> %s", (_name, err, expected) => {
    expect(classifySendError(err)).toBe(expected);
  });
});
