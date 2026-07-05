import CircuitBreaker from "opossum";

type AsyncAction<T> = () => Promise<T>;

class CircuitOpenError extends Error {
  constructor(service: string) {
    super(`${service} circuit breaker is open`);
    this.name = "CircuitOpenError";
  }
}

const breakerOptions = {
  errorThresholdPercentage: 100,
  resetTimeout: 30_000,
  timeout: false as const,
  volumeThreshold: 5,
};

const stripeCircuitBreaker = new CircuitBreaker<[AsyncAction<unknown>], unknown>(
  (action) => action(),
  { ...breakerOptions, name: "stripe" }
);

const smtpCircuitBreaker = new CircuitBreaker<[AsyncAction<unknown>], unknown>(
  (action) => action(),
  {
    ...breakerOptions,
    name: "smtp",
  }
);

function openAfterFiveFailures(breaker: CircuitBreaker<[AsyncAction<unknown>], unknown>) {
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
}

openAfterFiveFailures(stripeCircuitBreaker);
openAfterFiveFailures(smtpCircuitBreaker);

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
  stripeCircuitBreaker.close();
  smtpCircuitBreaker.close();
}

export function openStripeCircuitForTests() {
  stripeCircuitBreaker.open();
}
