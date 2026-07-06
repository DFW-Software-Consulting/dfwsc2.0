import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function getCircuitBreakers() {
  vi.resetModules();
  return import("../../lib/circuit-breakers");
}

describe("circuit-breakers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("opens the Stripe circuit after one success followed by five consecutive failures", async () => {
    const { getCircuitBreakerStates, isCircuitOpenError, withStripeCircuit } =
      await getCircuitBreakers();

    await expect(withStripeCircuit(() => Promise.resolve("ok"))).resolves.toBe("ok");

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        withStripeCircuit(() => Promise.reject(new Error("stripe down")))
      ).rejects.toThrow("stripe down");
    }

    expect(getCircuitBreakerStates().stripe.open).toBe(true);

    await expect(withStripeCircuit(() => Promise.resolve("ok"))).rejects.toSatisfy(
      isCircuitOpenError
    );
  });

  it("allows a half-open Stripe trial after resetTimeout", async () => {
    const { getCircuitBreakerStates, withStripeCircuit } = await getCircuitBreakers();

    await withStripeCircuit(() => Promise.resolve("ok"));

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        withStripeCircuit(() => Promise.reject(new Error("stripe down")))
      ).rejects.toThrow("stripe down");
    }

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getCircuitBreakerStates().stripe.halfOpen).toBe(true);

    await expect(withStripeCircuit(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("closes the Stripe circuit after a successful half-open trial", async () => {
    const { getCircuitBreakerStates, withStripeCircuit } = await getCircuitBreakers();

    await withStripeCircuit(() => Promise.resolve("ok"));

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        withStripeCircuit(() => Promise.reject(new Error("stripe down")))
      ).rejects.toThrow("stripe down");
    }

    await vi.advanceTimersByTimeAsync(30_000);
    await withStripeCircuit(() => Promise.resolve("ok"));

    expect(getCircuitBreakerStates().stripe).toMatchObject({
      closed: true,
      halfOpen: false,
      open: false,
    });
  });

  describe("isCircuitOpenError", () => {
    it("returns true for the fail-fast error thrown while the circuit is open", async () => {
      const { isCircuitOpenError, withStripeCircuit } = await getCircuitBreakers();

      await withStripeCircuit(() => Promise.resolve("ok"));
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(
          withStripeCircuit(() => Promise.reject(new Error("stripe down")))
        ).rejects.toThrow("stripe down");
      }

      let caught: unknown;
      try {
        await withStripeCircuit(() => Promise.resolve("ok"));
      } catch (error) {
        caught = error;
      }

      expect(isCircuitOpenError(caught)).toBe(true);
    });

    it("returns false for a plain Error unrelated to the circuit breaker", async () => {
      const { isCircuitOpenError } = await getCircuitBreakers();

      expect(isCircuitOpenError(new Error("just a regular error"))).toBe(false);
    });

    it("returns false for the wrapped function's own thrown error", async () => {
      const { isCircuitOpenError, withStripeCircuit } = await getCircuitBreakers();

      const originalError = new Error("stripe down");
      let caught: unknown;
      try {
        await withStripeCircuit(() => Promise.reject(originalError));
      } catch (error) {
        caught = error;
      }

      // The wrapper rethrows the action's own error untouched when the circuit
      // is closed — same reference, not a circuit-open error.
      expect(caught).toBe(originalError);
      expect(isCircuitOpenError(caught)).toBe(false);
    });
  });
});
