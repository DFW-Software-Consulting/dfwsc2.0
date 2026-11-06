import type { FastifyReply } from "fastify";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimitError } from "../../lib/concurrency-limiter";
import { mapStripeError } from "../../lib/stripe-errors";

// A Stripe 429 is Stripe asking us to slow down: it must not trip the breaker, and the caller
// must be told when to come back. These use real SDK error classes.

function rateLimitError() {
  return Stripe.errors.StripeError.generate({
    type: "rate_limit_error",
    statusCode: 429,
    message: "Too many requests",
  } as never);
}

function apiError(statusCode: number) {
  return Stripe.errors.StripeError.generate({
    type: "api_error",
    statusCode,
    message: `Stripe ${statusCode}`,
  } as never);
}

function fakeReply() {
  const send = vi.fn();
  const code = vi.fn().mockReturnValue({ send });
  const header = vi.fn();
  return { reply: { code, header } as unknown as FastifyReply, code, send, header };
}

const circuitOpen = { error: "open", code: "STRIPE_CIRCUIT_OPEN" };

describe("mapStripeError Retry-After", () => {
  it("answers a Stripe 429 with the caller's body and Retry-After 2", () => {
    const { reply, code, send, header } = fakeReply();
    const rateLimited = { error: "Payment service is busy. Please retry.", code: "RATE_LIMITED" };

    expect(mapStripeError(rateLimitError(), reply, { circuitOpen, rateLimited })).toBe(true);

    expect(code).toHaveBeenCalledWith(429);
    expect(send).toHaveBeenCalledWith(rateLimited);
    expect(header).toHaveBeenCalledWith("Retry-After", "2");
  });

  it("does not add Retry-After when the call site does not map rate limiting", () => {
    const { reply, header } = fakeReply();
    expect(mapStripeError(rateLimitError(), reply, { circuitOpen })).toBe(false);
    expect(header).not.toHaveBeenCalled();
  });

  it("maps a busy (no slot) error to 503 STRIPE_BUSY with Retry-After 5 for any call site", () => {
    for (const mapping of [{ circuitOpen }, { circuitOpen, permanentErrors: true }]) {
      const { reply, code, send, header } = fakeReply();
      expect(mapStripeError(new ConcurrencyLimitError("wait_timeout"), reply, mapping)).toBe(true);
      expect(code).toHaveBeenCalledWith(503);
      expect(send).toHaveBeenCalledWith({ error: expect.any(String), code: "STRIPE_BUSY" });
      expect(header).toHaveBeenCalledWith("Retry-After", "5");
    }
    const queueFull = fakeReply();
    expect(
      mapStripeError(new ConcurrencyLimitError("queue_full"), queueFull.reply, { circuitOpen })
    ).toBe(true);
    expect(queueFull.code).toHaveBeenCalledWith(503);
  });
});

describe("Stripe breaker and 429", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
  });

  const load = () => import("../../lib/circuit-breakers");

  it("never opens on a long run of Stripe 429s, and passes each error through", async () => {
    const { withStripeCircuit, getCircuitBreakerStates } = await load();
    const err = rateLimitError();

    for (let i = 0; i < 20; i++) {
      await expect(withStripeCircuit(() => Promise.reject(err))).rejects.toBe(err);
    }

    const state = getCircuitBreakerStates().stripe;
    expect(state.open).toBe(false);
    expect(state.closed).toBe(true);
    await expect(withStripeCircuit(async () => "ok")).resolves.toBe("ok");
  });

  it("treats a 429 as an answered call: it resets the consecutive-failure count", async () => {
    const { withStripeCircuit, getCircuitBreakerStates } = await load();

    // opossum emits "success" for a filtered error, which clears the consecutive count the
    // breaker's trip policy keeps, so 4 failures + a 429 + 4 failures does not open it.
    const fail = () => withStripeCircuit(() => Promise.reject(apiError(500))).catch(() => {});
    for (let i = 0; i < 4; i++) await fail();
    await withStripeCircuit(() => Promise.reject(rateLimitError())).catch(() => {});
    for (let i = 0; i < 4; i++) await fail();
    expect(getCircuitBreakerStates().stripe.open).toBe(false);

    // The fifth consecutive real failure still opens it.
    await fail();
    expect(getCircuitBreakerStates().stripe.open).toBe(true);
  });

  it("still opens after five consecutive 5xx errors and after five 401s", async () => {
    for (const status of [503, 401]) {
      vi.resetModules();
      const { withStripeCircuit, getCircuitBreakerStates } = await load();
      for (let i = 0; i < 5; i++) {
        await withStripeCircuit(() => Promise.reject(apiError(status))).catch(() => {});
      }
      expect(getCircuitBreakerStates().stripe.open).toBe(true);
    }
  });

  it("closes a half-open breaker when the trial call is answered with a 429", async () => {
    const { withStripeCircuit, getCircuitBreakerStates, openStripeCircuitForTests } = await load();
    openStripeCircuitForTests();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getCircuitBreakerStates().stripe.halfOpen).toBe(true);

    await withStripeCircuit(() => Promise.reject(rateLimitError())).catch(() => {});
    expect(getCircuitBreakerStates().stripe.closed).toBe(true);
  });
});
