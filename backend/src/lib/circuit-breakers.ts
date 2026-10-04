import CircuitBreaker from "opossum";
import { ConcurrencyLimitError, ConcurrencyLimiter } from "./concurrency-limiter";
import {
  STRIPE_MAX_CONCURRENT_CALLS,
  STRIPE_QUEUE_MAX_WAIT_MS,
  STRIPE_QUEUE_MAX_WAITING,
} from "./constants";

type AsyncAction<T> = () => Promise<T>;

class CircuitOpenError extends Error {
  constructor(service: string) {
    super(`${service} circuit breaker is open`);
    this.name = "CircuitOpenError";
  }
}

const breakerOptions = {
  // Disable opossum's percentage trip path; the consecutive-failure policy below is authoritative.
  errorThresholdPercentage: 101,
  resetTimeout: 30_000,
  timeout: 25_000,
  volumeThreshold: 5,
};

/**
 * opossum treats an error the filter returns true for as a success, not a failure: it emits
 * "success", which also resets the consecutive-failure count below and closes a half-open breaker.
 * Stripe 4xx responses other than 401 (invalid request, idempotency mismatch, permission, card
 * errors, and 429 rate limiting) mean Stripe answered and the request, not the service, was the
 * problem, so they must not count toward opening the process-wide breaker. A 429 in particular
 * is Stripe asking us to slow down, which the concurrency limit and callers' Retry-After handle;
 * opening the breaker would turn that into a 30 s outage for every building. A 401 means the
 * platform key is revoked or wrong, which is a platform-wide failure, so it still counts.
 * Connection errors (no status), 5xx and opossum timeouts also count.
 */
function isStripeCallerError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return (
    typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && statusCode !== 401
  );
}

/**
 * Permanent SMTP rejection of a recipient address (nodemailer sets `command: "RCPT TO"` and
 * a 5xx `responseCode`). That is bad input, not an outage; auth, connection, MAIL FROM, DATA
 * and temporary 4xx failures still count. `code: "EENVELOPE"` alone is not enough because
 * nodemailer also uses it for MAIL FROM and DATA failures.
 */
function isSmtpRecipientRejection(error: unknown): boolean {
  const err = error as { command?: unknown; responseCode?: unknown } | null;
  return (
    err?.command === "RCPT TO" &&
    typeof err.responseCode === "number" &&
    err.responseCode >= 500 &&
    err.responseCode < 600
  );
}

const stripeCircuitBreaker = new CircuitBreaker<[AsyncAction<unknown>], unknown>(
  (action) => action(),
  { ...breakerOptions, name: "stripe", errorFilter: isStripeCallerError }
);

const smtpCircuitBreaker = new CircuitBreaker<[AsyncAction<unknown>], unknown>(
  (action) => action(),
  {
    ...breakerOptions,
    name: "smtp",
    errorFilter: isSmtpRecipientRejection,
  }
);

function openAfterFiveConsecutiveFailures(
  breaker: CircuitBreaker<[AsyncAction<unknown>], unknown>
) {
  // Authoritative trip policy: open after five consecutive failures.
  // Opossum still provides state, metrics, half-open handling, and hung-call timeouts.
  let consecutiveFailures = 0;

  breaker.on("success", () => {
    consecutiveFailures = 0;
  });
  breaker.on("close", () => {
    consecutiveFailures = 0;
  });
  breaker.on("failure", () => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= 5) {
      breaker.open();
    }
  });

  return () => {
    consecutiveFailures = 0;
  };
}

const resetStripeFailureCount = openAfterFiveConsecutiveFailures(stripeCircuitBreaker);
const resetSmtpFailureCount = openAfterFiveConsecutiveFailures(smtpCircuitBreaker);

function normalizeCircuitError(error: unknown, service: string): never {
  if (CircuitBreaker.isOurError(error as Error)) {
    throw new CircuitOpenError(service);
  }
  throw error;
}

export function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError;
}

/**
 * Stripe calls are limited to a fixed number in flight. The limit sits in front of the breaker,
 * so time spent waiting for a slot, and a refusal to wait, never reach it: only calls that
 * actually go to Stripe can count as failures.
 */
const stripeConcurrency = new ConcurrencyLimiter({
  maxConcurrent: STRIPE_MAX_CONCURRENT_CALLS,
  maxWaiting: STRIPE_QUEUE_MAX_WAITING,
  maxWaitMs: STRIPE_QUEUE_MAX_WAIT_MS,
});

/** A Stripe call could not get a slot in time (waiting line full, or waited too long). Retryable. */
export function isStripeBusyError(error: unknown): error is ConcurrencyLimitError {
  return error instanceof ConcurrencyLimitError;
}

export async function withStripeCircuit<T>(action: AsyncAction<T>): Promise<T> {
  if (stripeCircuitBreaker.opened) {
    throw new CircuitOpenError("Stripe");
  }
  return stripeConcurrency.run(async () => {
    try {
      return (await stripeCircuitBreaker.fire(action as AsyncAction<unknown>)) as T;
    } catch (error) {
      // The breaker may have opened while this call waited for its slot.
      normalizeCircuitError(error, "Stripe");
    }
  });
}

export async function withSmtpCircuit<T>(action: AsyncAction<T>): Promise<T> {
  if (smtpCircuitBreaker.opened) {
    throw new CircuitOpenError("SMTP");
  }
  try {
    return (await smtpCircuitBreaker.fire(action as AsyncAction<unknown>)) as T;
  } catch (error) {
    normalizeCircuitError(error, "SMTP");
  }
}

function circuitState(breaker: CircuitBreaker<[AsyncAction<unknown>], unknown>) {
  return {
    open: breaker.opened,
    halfOpen: breaker.halfOpen,
    closed: breaker.closed,
    fires: breaker.stats.fires,
    failures: breaker.stats.failures,
    rejects: breaker.stats.rejects,
    successes: breaker.stats.successes,
    timeouts: breaker.stats.timeouts,
  };
}

export function getCircuitBreakerStates() {
  return {
    stripe: circuitState(stripeCircuitBreaker),
    smtp: circuitState(smtpCircuitBreaker),
  };
}

export function resetCircuitBreakersForTests() {
  resetStripeFailureCount();
  resetSmtpFailureCount();
  stripeCircuitBreaker.close();
  smtpCircuitBreaker.close();
}

export function openStripeCircuitForTests() {
  stripeCircuitBreaker.open();
}

export function configureStripeConcurrencyForTests(
  limits: Parameters<ConcurrencyLimiter["configure"]>[0]
) {
  stripeConcurrency.configure(limits);
}

export function resetStripeConcurrencyForTests() {
  stripeConcurrency.configure({
    maxConcurrent: STRIPE_MAX_CONCURRENT_CALLS,
    maxWaiting: STRIPE_QUEUE_MAX_WAITING,
    maxWaitMs: STRIPE_QUEUE_MAX_WAIT_MS,
  });
}

export function getStripeConcurrencyForTests() {
  return { inFlight: stripeConcurrency.inFlight, waiting: stripeConcurrency.waiting };
}
