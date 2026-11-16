// Timer-driven poller shared by the Nextcloud form automations: at most one cycle runs at a time
// plus one queued behind it, so a burst of triggers becomes one run and one follow-up.

export interface CyclePollerLogger {
  error(fields: Record<string, unknown>, msg: string): void;
}

export interface CyclePollerOptions {
  logger: CyclePollerLogger;
  /** Runs one cycle. */
  cycle: () => Promise<unknown>;
  intervalMs: number;
  /** Logged (with the error name only) when a cycle throws. */
  crashMessage: string;
  /** Runs inside `stop()` after the timer is cleared and before waiting for the running cycle. */
  onStop?: () => void;
}

export interface CyclePoller {
  /** Asks for a cycle now. One runs at a time; a request during a cycle queues one more. */
  trigger(): void;
  /** Stops the timer and waits for a running cycle to finish. */
  stop(): Promise<void>;
}

/** Starts the interval timer; the first cycle runs only once the caller calls `trigger()`. */
export function createCyclePoller(options: CyclePollerOptions): CyclePoller {
  const { logger, cycle, intervalMs, crashMessage, onStop } = options;
  let running: Promise<unknown> | null = null;
  let again = false;
  let stopped = false;
  const run = () => {
    running = cycle()
      .catch((error: unknown) => {
        logger.error({ errorName: (error as Error)?.name }, crashMessage);
      })
      .finally(() => {
        running = null;
        if (again && !stopped) {
          again = false;
          run();
        }
      });
  };
  const trigger = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    run();
  };
  const timer = setInterval(trigger, intervalMs);
  timer.unref();

  return {
    trigger,
    async stop() {
      stopped = true;
      clearInterval(timer);
      onStop?.();
      while (running) await running;
    },
  };
}
