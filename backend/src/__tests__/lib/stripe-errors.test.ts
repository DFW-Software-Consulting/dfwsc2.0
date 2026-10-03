import type { FastifyReply } from "fastify";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { mapStripeError } from "../../lib/stripe-errors";

function fakeReply() {
  const send = vi.fn();
  const code = vi.fn().mockReturnValue({ send });
  return { reply: { code } as unknown as FastifyReply, code, send };
}

// Legacy shape: some errors identify themselves via `name` only.
function stripeError(name: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name }, extra);
}

// Real SDK errors: stripe-node sets `type` to the class name and leaves `name` as "Error".
function sdkError(
  type: string,
  statusCode: number,
  message: string,
  extra: Record<string, unknown> = {}
) {
  return Stripe.errors.StripeError.generate({ type, statusCode, message, ...extra } as never);
}

const circuitOpen = { error: "open", code: "STRIPE_CIRCUIT_OPEN" };

describe("mapStripeError permanent errors", () => {
  it("maps StripeInvalidRequestError to 400 with Stripe's message and param", () => {
    const { reply, code, send } = fakeReply();
    const err = stripeError("StripeInvalidRequestError", "Invalid currency: xyz", {
      param: "currency",
    });

    expect(mapStripeError(err, reply, { circuitOpen, permanentErrors: true })).toBe(true);

    expect(code).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({
      error: "Invalid currency: xyz",
      code: "INVALID_REQUEST",
      param: "currency",
    });
  });

  it("omits param when Stripe did not supply one", () => {
    const { reply, send } = fakeReply();
    mapStripeError(stripeError("StripeInvalidRequestError", "bad"), reply, {
      circuitOpen,
      permanentErrors: true,
    });
    expect(send).toHaveBeenCalledWith({ error: "bad", code: "INVALID_REQUEST" });
  });

  it("maps StripeIdempotencyError to 409 IDEMPOTENCY_KEY_REUSED", () => {
    const { reply, code, send } = fakeReply();
    const err = stripeError(
      "StripeIdempotencyError",
      "Keys for idempotent requests can only be used with the same parameters"
    );

    expect(mapStripeError(err, reply, { circuitOpen, permanentErrors: true })).toBe(true);

    expect(code).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({ error: err.message, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("maps an in-flight idempotency conflict to a retryable 409 IDEMPOTENCY_KEY_IN_USE", () => {
    const { reply, code, send } = fakeReply();
    const err = sdkError(
      "idempotency_error",
      409,
      "There is currently another in-progress request",
      {
        code: "idempotency_key_in_use",
      }
    );

    expect(mapStripeError(err, reply, { circuitOpen, permanentErrors: true })).toBe(true);

    expect(code).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({
      error: expect.stringContaining("Retry shortly with the same key"),
      code: "IDEMPOTENCY_KEY_IN_USE",
    });
  });

  it("maps an in-flight conflict sent as invalid_request_error to IDEMPOTENCY_KEY_IN_USE", () => {
    const { reply, code, send } = fakeReply();
    const err = sdkError(
      "invalid_request_error",
      409,
      "There is currently another in-progress request",
      {
        code: "idempotency_key_in_use",
      }
    );
    expect(err).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);

    expect(mapStripeError(err, reply, { circuitOpen, permanentErrors: true })).toBe(true);

    expect(code).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({
      error: expect.stringContaining("Retry shortly with the same key"),
      code: "IDEMPOTENCY_KEY_IN_USE",
    });
  });

  it("keeps a real SDK parameter-mismatch idempotency error as IDEMPOTENCY_KEY_REUSED", () => {
    const { reply, code, send } = fakeReply();
    const err = sdkError(
      "idempotency_error",
      400,
      "Keys for idempotent requests can only be used with the same parameters"
    );

    expect(mapStripeError(err, reply, { circuitOpen, permanentErrors: true })).toBe(true);

    expect(code).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({ error: err.message, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("maps StripePermissionError to 409 ACCOUNT_NOT_CONNECTED", () => {
    const { reply, code, send } = fakeReply();

    expect(
      mapStripeError(stripeError("StripePermissionError", "no access"), reply, {
        circuitOpen,
        permanentErrors: true,
      })
    ).toBe(true);

    expect(code).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({
      error: "Client Stripe account is not connected or cannot accept charges.",
      code: "ACCOUNT_NOT_CONNECTED",
    });
  });

  it("leaves permanent errors unhandled unless the call site opts in", () => {
    const { reply, code } = fakeReply();

    expect(
      mapStripeError(stripeError("StripeInvalidRequestError", "bad"), reply, { circuitOpen })
    ).toBe(false);
    expect(code).not.toHaveBeenCalled();
  });

  it("does not map transient errors even when opted in", () => {
    const { reply, code } = fakeReply();

    expect(
      mapStripeError(stripeError("StripeAPIError", "boom", { statusCode: 500 }), reply, {
        circuitOpen,
        permanentErrors: true,
      })
    ).toBe(false);
    expect(code).not.toHaveBeenCalled();
  });

  describe("with real Stripe SDK errors", () => {
    const opts = { circuitOpen, permanentErrors: true };

    it("generates SDK errors whose name is not the class name", () => {
      const err = sdkError("invalid_request_error", 400, "x");
      expect(err.name).toBe("Error");
      expect(err.type).toBe("StripeInvalidRequestError");
    });

    it("maps an invalid_request_error to 400 with Stripe's message and param", () => {
      const { reply, code, send } = fakeReply();
      const err = sdkError("invalid_request_error", 400, "Invalid currency: xyz", {
        param: "currency",
      });

      expect(mapStripeError(err, reply, opts)).toBe(true);

      expect(code).toHaveBeenCalledWith(400);
      expect(send).toHaveBeenCalledWith({
        error: "Invalid currency: xyz",
        code: "INVALID_REQUEST",
        param: "currency",
      });
    });

    it("maps an idempotency_error to 409 IDEMPOTENCY_KEY_REUSED", () => {
      const { reply, code, send } = fakeReply();
      const err = sdkError("idempotency_error", 400, "Keys for idempotent requests mismatch");

      expect(mapStripeError(err, reply, opts)).toBe(true);

      expect(code).toHaveBeenCalledWith(409);
      expect(send).toHaveBeenCalledWith({ error: err.message, code: "IDEMPOTENCY_KEY_REUSED" });
    });

    it("maps StripePermissionError to 409 ACCOUNT_NOT_CONNECTED", () => {
      const { reply, code, send } = fakeReply();
      const err = new Stripe.errors.StripePermissionError({
        type: "invalid_request_error",
        statusCode: 403,
        message: "The provided key does not have access to this account.",
      } as never);

      expect(mapStripeError(err, reply, opts)).toBe(true);

      expect(code).toHaveBeenCalledWith(409);
      expect(send).toHaveBeenCalledWith({
        error: "Client Stripe account is not connected or cannot accept charges.",
        code: "ACCOUNT_NOT_CONNECTED",
      });
    });

    it("maps card and rate-limit SDK errors for call sites that opt in", () => {
      const card = fakeReply();
      expect(
        mapStripeError(sdkError("card_error", 402, "Your card was declined."), card.reply, {
          circuitOpen,
          cardDeclinedCode: "CARD_DECLINED",
        })
      ).toBe(true);
      expect(card.code).toHaveBeenCalledWith(402);
      expect(card.send).toHaveBeenCalledWith({
        error: "Your card was declined.",
        code: "CARD_DECLINED",
      });

      const limited = fakeReply();
      const rateLimited = { error: "busy", code: "RATE_LIMITED" };
      expect(
        mapStripeError(sdkError("rate_limit_error", 429, "slow down"), limited.reply, {
          circuitOpen,
          rateLimited,
        })
      ).toBe(true);
      expect(limited.code).toHaveBeenCalledWith(429);
      expect(limited.send).toHaveBeenCalledWith(rateLimited);
    });

    it("does not map SDK connection or API errors", () => {
      const { reply, code } = fakeReply();
      expect(mapStripeError(sdkError("api_error", 500, "boom"), reply, opts)).toBe(false);
      expect(
        mapStripeError(
          new Stripe.errors.StripeConnectionError({ message: "down" } as never),
          reply,
          opts
        )
      ).toBe(false);
      expect(code).not.toHaveBeenCalled();
    });
  });
});
