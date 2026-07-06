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
});
