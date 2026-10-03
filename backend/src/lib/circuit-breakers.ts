import CircuitBreaker from "opossum";

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
 * opossum treats an error the filter returns true for as a success, not a failure.
 * Stripe 4xx responses other than 429 and 401 (invalid request, idempotency mismatch,
 * permission, card errors) mean Stripe answered and the caller's input was wrong, so they
 * must not count toward opening the process-wide breaker. A 401 means the platform key is
 * revoked or wrong, which is a platform-wide failure, so it still counts. Connection errors
 * (no status), 5xx, 429 and opossum timeouts also count.
 */
function isStripeCallerError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return (
    typeof statusCode === "number" &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 429 &&
    statusCode !== 401
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

export async function withStripeCircuit<T>(action: AsyncAction<T>): Promise<T> {
  if (stripeCircuitBreaker.opened) {
    throw new CircuitOpenError("Stripe");
  }
  try {
    return (await stripeCircuitBreaker.fire(action as AsyncAction<unknown>)) as T;
  } catch (error) {
    normalizeCircuitError(error, "Stripe");
  }
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
