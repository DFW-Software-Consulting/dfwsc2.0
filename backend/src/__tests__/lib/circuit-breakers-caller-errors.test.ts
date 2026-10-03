import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function getCircuitBreakers() {
  vi.resetModules();
  return import("../../lib/circuit-breakers");
}

function stripeError(name: string, statusCode?: number) {
  const err = new Error(`${name} message`) as Error & { statusCode?: number };
  err.name = name;
  if (statusCode !== undefined) err.statusCode = statusCode;
  return err;
}

function smtpError(props: { code?: string; command?: string; responseCode?: number }) {
  return Object.assign(new Error("smtp failure"), props);
}

describe("circuit-breakers caller-error handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
  });

  it.each([
    ["StripeInvalidRequestError", 400],
    ["StripeIdempotencyError", 400],
    ["StripePermissionError", 403],
    ["StripeCardError", 402],
  ])("does not open the Stripe circuit on repeated %s (%i)", async (name, status) => {
    const { getCircuitBreakerStates, withStripeCircuit } = await getCircuitBreakers();

    for (let attempt = 0; attempt < 8; attempt++) {
      await expect(
        withStripeCircuit(() => Promise.reject(stripeError(name, status)))
      ).rejects.toThrow(`${name} message`);
    }

    expect(getCircuitBreakerStates().stripe.closed).toBe(true);
    await expect(withStripeCircuit(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it.each([
    ["StripeConnectionError", undefined],
    ["StripeAPIError", 500],
    ["StripeAPIError", 503],
    ["StripeRateLimitError", 429],
    ["StripeAuthenticationError", 401],
  ])("still opens the Stripe circuit on five consecutive %s (%s)", async (name, status) => {
    const { getCircuitBreakerStates, withStripeCircuit } = await getCircuitBreakers();

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        withStripeCircuit(() => Promise.reject(stripeError(name, status)))
      ).rejects.toThrow(`${name} message`);
    }

    expect(getCircuitBreakerStates().stripe.open).toBe(true);
  });

  it("does not let a caller error as the half-open trial re-open the Stripe circuit", async () => {
    const { getCircuitBreakerStates, withStripeCircuit } = await getCircuitBreakers();

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        withStripeCircuit(() => Promise.reject(stripeError("StripeAPIError", 500)))
      ).rejects.toThrow();
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getCircuitBreakerStates().stripe.halfOpen).toBe(true);

    await expect(
      withStripeCircuit(() => Promise.reject(stripeError("StripeInvalidRequestError", 400)))
    ).rejects.toThrow();

    expect(getCircuitBreakerStates().stripe.open).toBe(false);
  });

  it("does not open the SMTP circuit on permanent recipient rejections", async () => {
    const { getCircuitBreakerStates, withSmtpCircuit } = await getCircuitBreakers();

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        withSmtpCircuit(() =>
          Promise.reject(smtpError({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }))
        )
      ).rejects.toThrow("smtp failure");
      await expect(
        withSmtpCircuit(() => Promise.reject(smtpError({ command: "RCPT TO", responseCode: 553 })))
      ).rejects.toThrow("smtp failure");
    }

    expect(getCircuitBreakerStates().smtp.closed).toBe(true);
  });

  it("counts real SDK errors by status: caller errors do not open, outages do", async () => {
    const Stripe = (await import("stripe")).default;
    const { getCircuitBreakerStates, withStripeCircuit } = await getCircuitBreakers();
    const invalid = Stripe.errors.StripeError.generate({
      type: "invalid_request_error",
      statusCode: 400,
      message: "bad",
    } as never);

    for (let attempt = 0; attempt < 8; attempt++) {
      await expect(withStripeCircuit(() => Promise.reject(invalid))).rejects.toBe(invalid);
    }
    expect(getCircuitBreakerStates().stripe.closed).toBe(true);

    const apiError = Stripe.errors.StripeError.generate({
      type: "api_error",
      statusCode: 500,
      message: "boom",
    } as never);
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(withStripeCircuit(() => Promise.reject(apiError))).rejects.toBe(apiError);
    }
    expect(getCircuitBreakerStates().stripe.open).toBe(true);
  });

  it.each([
    ["MAIL FROM rejection", { code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 }],
    ["DATA failure", { code: "EENVELOPE", command: "DATA", responseCode: 554 }],
    ["temporary RCPT TO rejection", { code: "EENVELOPE", command: "RCPT TO", responseCode: 451 }],
  ])("still opens the SMTP circuit on an EENVELOPE %s", async (_label, props) => {
    const { getCircuitBreakerStates, withSmtpCircuit } = await getCircuitBreakers();

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(withSmtpCircuit(() => Promise.reject(smtpError(props)))).rejects.toThrow(
        "smtp failure"
      );
    }

    expect(getCircuitBreakerStates().smtp.open).toBe(true);
  });

  it("still opens the SMTP circuit on connection and auth failures", async () => {
    const { getCircuitBreakerStates, withSmtpCircuit } = await getCircuitBreakers();

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        withSmtpCircuit(() => Promise.reject(smtpError({ code: "ECONNECTION" })))
      ).rejects.toThrow("smtp failure");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        withSmtpCircuit(() =>
          Promise.reject(smtpError({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }))
        )
      ).rejects.toThrow("smtp failure");
    }

    expect(getCircuitBreakerStates().smtp.open).toBe(true);
  });
});
