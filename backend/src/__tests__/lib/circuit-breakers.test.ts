import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCircuitBreakerStates,
  isCircuitOpenError,
  resetCircuitBreakersForTests,
  withStripeCircuit,
} from "../../lib/circuit-breakers";

// circuit-breakers.ts opens the breaker after 5 *consecutive* failures via the
// non-exported `openAfterFiveFailures()` helper. That threshold is a hardcoded
// literal inside the module, not an exported config constant, so we mirror
// the real value here rather than invent one.
const FAILURE_THRESHOLD = 5;

// Mirrors the non-exported `breakerOptions.resetTimeout` (30s) in
// circuit-breakers.ts, which opossum uses (via a real `setTimeout`) to move
// the breaker from open to half-open.
const RESET_TIMEOUT_MS = 30_000;

beforeAll(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // circuit-breakers.ts exports a real reset seam for tests: `.close()` on
  // both underlying opossum breakers, which also resets the module's local
  // `consecutiveFailures` counters (they listen for the `close` event). No
  // resetModules()/dynamic-import dance is needed since the singletons expose
  // this hook directly.
  resetCircuitBreakersForTests();
});

/**
 * Drives exactly FAILURE_THRESHOLD failing calls through the real
 * `withStripeCircuit` wrapper so the breaker trips. The breaker is closed
 * going into each of these calls, so each one reaches the underlying action
 * and rejects with the action's own error - only the call made *after* this
 * helper returns is expected to fail fast.
 */
async function tripStripeBreaker(failingAction: () => Promise<unknown>) {
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    await expect(withStripeCircuit(failingAction)).rejects.toThrow("stripe down");
  }
}

describe("circuit-breakers", () => {
  describe("withStripeCircuit - failure threshold", () => {
    it("trips the breaker after the real configured threshold, then fails the next call fast", async () => {
      const failingAction = vi.fn().mockRejectedValue(new Error("stripe down"));

      await tripStripeBreaker(failingAction);

      expect(failingAction).toHaveBeenCalledTimes(FAILURE_THRESHOLD);
      expect(getCircuitBreakerStates().stripe.open).toBe(true);

      let caught: unknown;
      try {
        await withStripeCircuit(failingAction);
      } catch (error) {
        caught = error;
      }

      // Fails fast: the underlying action is not invoked a 6th time, and the
      // real circuit-open error type comes back.
      expect(failingAction).toHaveBeenCalledTimes(FAILURE_THRESHOLD);
      expect(isCircuitOpenError(caught)).toBe(true);
    });
  });

  describe("withStripeCircuit - half-open probe after cooldown", () => {
    it("lets the next call through as a probe once the reset timeout has elapsed", async () => {
      const failingAction = vi.fn().mockRejectedValue(new Error("stripe down"));
      await tripStripeBreaker(failingAction);
      expect(getCircuitBreakerStates().stripe.open).toBe(true);

      vi.advanceTimersByTime(RESET_TIMEOUT_MS + 1);

      expect(getCircuitBreakerStates().stripe.open).toBe(false);
      expect(getCircuitBreakerStates().stripe.halfOpen).toBe(true);

      const probeAction = vi.fn().mockResolvedValue("probe result");
      const result = await withStripeCircuit(probeAction);

      // The probe was let through rather than failed fast.
      expect(probeAction).toHaveBeenCalledTimes(1);
      expect(result).toBe("probe result");
    });
  });

  describe("withStripeCircuit - closes on a successful probe", () => {
    it("returns to closed state after the probe succeeds, and lets subsequent calls through normally", async () => {
      const failingAction = vi.fn().mockRejectedValue(new Error("stripe down"));
      await tripStripeBreaker(failingAction);
      vi.advanceTimersByTime(RESET_TIMEOUT_MS + 1);

      const probeAction = vi.fn().mockResolvedValue("recovered");
      const probeResult = await withStripeCircuit(probeAction);
      expect(probeResult).toBe("recovered");

      const state = getCircuitBreakerStates().stripe;
      expect(state.closed).toBe(true);
      expect(state.open).toBe(false);
      expect(state.halfOpen).toBe(false);

      const nextAction = vi.fn().mockResolvedValue("still fine");
      const nextResult = await withStripeCircuit(nextAction);

      // Not failed fast - the breaker is closed and lets calls through as normal.
      expect(nextAction).toHaveBeenCalledTimes(1);
      expect(nextResult).toBe("still fine");
    });
  });

  describe("isCircuitOpenError", () => {
    it("returns true for the real circuit-open error thrown when failing fast", async () => {
      const failingAction = vi.fn().mockRejectedValue(new Error("stripe down"));
      await tripStripeBreaker(failingAction);

      let caught: unknown;
      try {
        await withStripeCircuit(vi.fn());
      } catch (error) {
        caught = error;
      }

      expect(isCircuitOpenError(caught)).toBe(true);
    });

    it("returns false for a plain Error unrelated to the circuit breaker", () => {
      expect(isCircuitOpenError(new Error("just a regular error"))).toBe(false);
    });

    it("returns false for the underlying wrapped function's own thrown error", async () => {
      const originalError = new Error("stripe down");
      const failingAction = vi.fn().mockRejectedValue(originalError);

      let caught: unknown;
      try {
        await withStripeCircuit(failingAction);
      } catch (error) {
        caught = error;
      }

      // The wrapper rethrows the action's own error untouched when it isn't
      // an opossum-internal error - same reference, not a CircuitOpenError.
      expect(caught).toBe(originalError);
      expect(isCircuitOpenError(caught)).toBe(false);
    });
  });
});
