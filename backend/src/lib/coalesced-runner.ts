// Event-driven triggers for the background jobs. A job's own timer stays as the safety net;
// this runner lets an event (a webhook, a database write) start a cycle at once instead.
//
// At most one cycle runs at a time plus one queued behind it, so a burst of kicks becomes one
// run and one follow-up. A cycle that comes back "busy" (another process holds the job's
// advisory lock) is retried once after a short delay instead of being dropped.

import { KICK_BUSY_RETRY_MS } from "./constants";

export interface CoalescedRunnerLogger {
  error(fields: Record<string, unknown>, msg: string): void;
}

export interface CoalescedRunnerOptions {
  name: string;
  logger: CoalescedRunnerLogger;
  /** Runs one cycle; its result is passed to `isBusy`. */
  cycle: () => Promise<unknown>;
  /** True when the cycle did nothing because another process held the lock. */
  isBusy?: (result: unknown) => boolean;
  /** Wait before the single retry of a busy cycle. */
  busyRetryMs?: number;
  /** `kick()` waits this long so a burst of writes becomes one cycle. */
  debounceMs?: number;
}

export interface CoalescedRunner {
  /** Runs a cycle now, or queues one behind the running cycle. */
  trigger(): void;
  /** Debounced trigger for event sources. */
  kick(): void;
  /** Stops new cycles and waits for the running one. */
  stop(): Promise<void>;
}

export function createCoalescedRunner(options: CoalescedRunnerOptions): CoalescedRunner {
  const { name, logger, cycle, isBusy, busyRetryMs = KICK_BUSY_RETRY_MS } = options;
  const debounceMs = options.debounceMs ?? 0;
  let running: Promise<unknown> | null = null;
  let again = false;
  let stopped = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  const run = (isRetry: boolean) => {
    again = false;
    running = (async () => {
      try {
        return await cycle();
      } catch (error) {
        logger.error({ errorName: (error as Error)?.name, job: name }, "Cycle crashed.");
        return undefined;
      }
    })().then((result) => {
      running = null;
      if (stopped) return;
      if (again) {
        run(false);
      } else if (!isRetry && isBusy?.(result)) {
        // The lock holder may be mid-cycle with stale data: look again shortly, once.
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (stopped) return;
          if (running) again = true;
          else run(true);
        }, busyRetryMs);
        retryTimer.unref();
      }
    });
  };
  const trigger = () => {
    if (stopped) return;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (running) {
      again = true;
      return;
    }
    run(false);
  };
  const kick = () => {
    if (stopped) return;
    if (debounceMs <= 0) return trigger();
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      trigger();
    }, debounceMs);
    debounceTimer.unref();
  };

  return {
    trigger,
    kick,
    async stop() {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (retryTimer) clearTimeout(retryTimer);
      debounceTimer = retryTimer = null;
      while (running) await running;
    },
  };
}

// ── Registry ─────────────────────────────────────────────────────────────────
// Write sites call `kickJob(name)` without importing the job module (which would pull the
// Nextcloud/Stripe clients into every route). A job registers its runner when it starts.

export type KickableJob = "salesLead" | "billingMirror" | "portalMirror" | "stripeIdWriteback";

const registered = new Map<KickableJob, CoalescedRunner>();

export function registerKickable(job: KickableJob, runner: CoalescedRunner): () => void {
  registered.set(job, runner);
  return () => {
    if (registered.get(job) === runner) registered.delete(job);
  };
}

/** Starts (or queues) a cycle of a job. A no-op when the job is off or not started; never throws. */
export function kickJob(job: KickableJob): void {
  try {
    registered.get(job)?.kick();
  } catch {
    // A kick is an optimisation; the job's own timer is the safety net.
  }
}
