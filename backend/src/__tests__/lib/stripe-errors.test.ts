import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { mapStripeError } from "../../lib/stripe-errors";

function fakeReply() {
  const send = vi.fn();
  const code = vi.fn().mockReturnValue({ send });
  return { reply: { code } as unknown as FastifyReply, code, send };
}

function stripeError(name: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name }, extra);
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
});
