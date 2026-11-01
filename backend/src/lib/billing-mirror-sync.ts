import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { billingCustomers, billingSnapshots, portalMirrorRows } from "../db/schema";
import {
  BILLING_KEY,
  BILLING_TABLE_TITLE,
  billingColumns,
  renderBillingRow,
} from "./billing-mirror-render";
import { runBillingRefresh } from "./billing-snapshot";
import type { BillingValues } from "./billing-status";
import {
  AuthBackoff,
  intVar,
  isAuthError,
  isOutage,
  type MirrorLogger,
  PortalMirrorConfigError,
  type ProvisionCache,
  parseShareGroups,
  provisionMirrorTable,
  pushMirrorRow,
  reconcileMirrorRows,
  recordMirrorFailure,
  staleMirrorRows,
  withMirrorLock,
} from "./mirror-table";
import { billingMirrorRequest, getNextcloudConfig, type NextcloudConfig } from "./nextcloud";
import { PortalMirrorNextcloud } from "./portal-mirror-nextcloud";
import { contentHash, type RenderedValues } from "./portal-mirror-render";

// Read-only mirror of the billing side of the portal (billing_customers + billing_snapshots, the
// state of DFWSC's own clients as Stripe Customers on the platform account) into the Nextcloud
// Table "Client Billing". Reuses the Portal Accounts mirror's infrastructure (lib/mirror-table.ts:
// provisioning by title, read-only shares, advisory lock, per-row backoff, daily reconcile).
// Off unless BILLING_MIRROR=true. The database is the source of truth; edits made in Nextcloud
// are overwritten.
//
// Every cycle re-renders every row (a few dozen at most, one query) and writes only rows whose
// content hash differs from the stored one, so a new sibling client code on a shared Customer or a
// renamed company needs no change tracking of its own.
//
// Logs carry ids, counts and error names only.

const KIND = "billing" as const;
const STATE_KEY = "billing_table_id";
const CYCLE_LOCK_NAME = "billing_mirror_cycle";
const DEFAULT_SHARE_GROUPS = ["dfwsc-admins", "managers"];
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MIN_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
const DEFAULT_BATCH = 25;
const MAX_BATCH = 100;
const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;

interface BillingMirrorSettings {
  nextcloud: NextcloudConfig;
  intervalMs: number;
  sweepIntervalMs: number;
  batch: number;
  shareGroups: string[];
  minGapMs: number;
}

type ConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; problems: string[] }
  | { status: "ready"; settings: BillingMirrorSettings };

export function loadBillingMirrorConfig(env: NodeJS.ProcessEnv): ConfigResult {
  if (env.BILLING_MIRROR?.trim() !== "true") return { status: "disabled" };
  const problems: string[] = [];
  const nc = getNextcloudConfig(env);
  if (!nc.ok) {
    problems.push(
      nc.reason === "not_configured"
        ? "NEXTCLOUD_BASE_URL, NEXTCLOUD_USERNAME and NEXTCLOUD_APP_PASSWORD are required"
        : "NEXTCLOUD_BASE_URL must be a valid https:// URL"
    );
  }
  // The loop cadence and batch size are the Portal Accounts mirror's (PORTAL_MIRROR_*).
  const intervalMs = intVar(
    env.PORTAL_MIRROR_INTERVAL_MS,
    "PORTAL_MIRROR_INTERVAL_MS",
    MIN_INTERVAL_MS,
    24 * 60 * 60 * 1000,
    DEFAULT_INTERVAL_MS,
    problems
  );
  const batch = intVar(
    env.PORTAL_MIRROR_BATCH,
    "PORTAL_MIRROR_BATCH",
    1,
    MAX_BATCH,
    DEFAULT_BATCH,
    problems
  );
  const sweepIntervalMs = intVar(
    env.BILLING_SWEEP_INTERVAL_MS,
    "BILLING_SWEEP_INTERVAL_MS",
    MIN_SWEEP_INTERVAL_MS,
    7 * 24 * 60 * 60 * 1000,
    DEFAULT_SWEEP_INTERVAL_MS,
    problems
  );
  const shareGroups = parseShareGroups(
    env.BILLING_MIRROR_SHARE_GROUPS,
    "BILLING_MIRROR_SHARE_GROUPS",
    DEFAULT_SHARE_GROUPS,
    problems
  );
  if (!nc.ok || problems.length) return { status: "invalid", problems };
  return {
    status: "ready",
    settings: {
      nextcloud: nc.config,
      intervalMs,
      sweepIntervalMs,
      batch,
      shareGroups,
      minGapMs: 200,
    },
  };
}

// ── State ────────────────────────────────────────────────────────────────────

export interface BillingMirrorResult {
  status:
    | "disabled"
    | "invalid_config"
    | "nextcloud_unavailable"
    | "busy"
    | "backoff"
    | "error"
    | "ok";
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failed: number;
  reconciled: boolean;
}

const result = (
  status: BillingMirrorResult["status"],
  extra: Partial<BillingMirrorResult> = {}
): BillingMirrorResult => ({
  status,
  created: 0,
  updated: 0,
  unchanged: 0,
  deleted: 0,
  failed: 0,
  reconciled: false,
  ...extra,
});

const provisionCache: ProvisionCache = { current: null };
let lastReconcileAt = 0;
let lastLoggedProblem: string | null = null;
const authBackoff = new AuthBackoff();

export function resetBillingMirrorStateForTests() {
  provisionCache.current = null;
  lastReconcileAt = 0;
  lastLoggedProblem = null;
  authBackoff.reset();
}

function logProblemOnce(
  logger: MirrorLogger,
  key: string,
  fields: Record<string, unknown>,
  msg: string
) {
  if (lastLoggedProblem === key) return;
  lastLoggedProblem = key;
  logger.error(fields, msg);
}

// ── Cycle ────────────────────────────────────────────────────────────────────

/** Every row that should exist: one per billing_customers client code, snapshot or not. */
async function loadExpected(): Promise<Map<string, RenderedValues>> {
  const rows = await db
    .select({ customer: billingCustomers, snapshot: billingSnapshots })
    .from(billingCustomers)
    .leftJoin(billingSnapshots, eq(billingSnapshots.clientCode, billingCustomers.clientCode));
  const codesByCustomer = new Map<string, string[]>();
  for (const { customer } of rows) {
    codesByCustomer.set(customer.stripeCustomerId, [
      ...(codesByCustomer.get(customer.stripeCustomerId) ?? []),
      customer.clientCode,
    ]);
  }
  return new Map(
    rows.map(({ customer, snapshot }) => [
      customer.clientCode,
      renderBillingRow({
        company: customer.company,
        clientCode: customer.clientCode,
        stripeCustomerId: customer.stripeCustomerId,
        sharedWith: (codesByCustomer.get(customer.stripeCustomerId) ?? []).filter(
          (code) => code !== customer.clientCode
        ),
        values: (snapshot?.rendered as BillingValues | null | undefined) ?? null,
        failed: snapshot ? snapshot.attempts > 0 || snapshot.lastError !== null : false,
        updatedAt: snapshot?.rendered ? snapshot.updatedAt : null,
        refreshedAt: snapshot?.refreshedAt ?? null,
      }),
    ])
  );
}

async function syncOnce(
  settings: BillingMirrorSettings,
  logger: MirrorLogger,
  cycleStart: Date
): Promise<BillingMirrorResult> {
  const nc = new PortalMirrorNextcloud(settings.nextcloud, settings.minGapMs, billingMirrorRequest);
  const out = result("ok");
  const { value: prov, changed } = await provisionMirrorTable(
    nc,
    {
      title: BILLING_TABLE_TITLE,
      emoji: "💳",
      stateKey: STATE_KEY,
      specs: billingColumns(),
      shareGroups: settings.shareGroups,
      baseUrl: settings.nextcloud.baseUrl,
      overrideTableId: null,
    },
    provisionCache,
    logger
  );
  if (changed) lastReconcileAt = 0; // rows or cells may be missing: reconcile this cycle

  const expected = await loadExpected();
  if (Date.now() - lastReconcileAt >= RECONCILE_EVERY_MS) {
    await reconcileMirrorRows(nc, prov, KIND, BILLING_KEY, expected, cycleStart);
    lastReconcileAt = Date.now();
    out.reconciled = true;
  }

  const mappings = new Map(
    (await db.select().from(portalMirrorRows).where(eq(portalMirrorRows.kind, KIND))).map((r) => [
      r.sourceId,
      r,
    ])
  );
  let writes = 0;
  for (const [sourceId, values] of expected) {
    const mapping = mappings.get(sourceId) ?? null;
    if (mapping?.nextAttemptAt && mapping.nextAttemptAt.getTime() > Date.now()) continue;
    if (mapping?.ncRowId != null && mapping.contentHash === contentHash(values)) {
      out.unchanged += 1;
      continue;
    }
    if (writes >= settings.batch) break;
    writes += 1;
    try {
      const outcome = await pushMirrorRow(nc, prov, KIND, sourceId, values, mapping, cycleStart);
      out[outcome] += 1;
    } catch (error) {
      if (isOutage(error)) throw error;
      out.failed += 1;
      logger.warn(
        { clientCode: sourceId, errorName: (error as Error)?.name },
        "Billing mirror could not write a row; will retry with backoff."
      );
      await recordMirrorFailure(KIND, sourceId, mapping?.attempts ?? 0, error);
    }
  }

  // Rows whose client code is gone: remove from Nextcloud, then forget.
  for (const row of await staleMirrorRows(KIND, expected)) {
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > Date.now()) continue;
    try {
      if (row.ncRowId !== null) await nc.deleteRow(row.ncRowId);
      await db
        .delete(portalMirrorRows)
        .where(and(eq(portalMirrorRows.kind, KIND), eq(portalMirrorRows.sourceId, row.sourceId)));
      out.deleted += 1;
    } catch (error) {
      if (isOutage(error)) throw error;
      out.failed += 1;
      await recordMirrorFailure(KIND, row.sourceId, row.attempts, error);
    }
  }

  if (out.created || out.updated || out.deleted || out.failed || out.reconciled) {
    logger.info(
      {
        created: out.created,
        updated: out.updated,
        unchanged: out.unchanged,
        deleted: out.deleted,
        failed: out.failed,
        reconciled: out.reconciled,
      },
      "Billing mirror cycle finished."
    );
  }
  return out;
}

export async function runBillingMirrorCycle(options: {
  logger: MirrorLogger;
  env?: NodeJS.ProcessEnv;
  /** Tests only: overrides the 200 ms spacing between Nextcloud calls. */
  minGapMs?: number;
}): Promise<BillingMirrorResult> {
  const { logger, env = process.env } = options;
  const config = loadBillingMirrorConfig(env);
  if (config.status === "disabled") return result("disabled");
  if (config.status === "invalid") {
    logProblemOnce(
      logger,
      `invalid:${config.problems.join("|")}`,
      { problems: config.problems },
      "Billing mirror is enabled but its config is invalid; skipped."
    );
    return result("invalid_config");
  }
  if (options.minGapMs !== undefined) config.settings.minGapMs = options.minGapMs;
  if (Date.now() < authBackoff.until) return result("backoff");
  try {
    const outcome = await withMirrorLock(CYCLE_LOCK_NAME, logger, result("busy"), (started) =>
      syncOnce(config.settings, logger, started)
    );
    if (outcome.status === "ok") {
      lastLoggedProblem = null;
      authBackoff.succeeded();
    }
    return outcome;
  } catch (error) {
    if (error instanceof PortalMirrorConfigError) {
      logProblemOnce(
        logger,
        `config:${error.detail}`,
        { detail: error.detail },
        "Billing mirror misconfigured."
      );
      return result("invalid_config");
    }
    if (isOutage(error)) {
      if (isAuthError(error)) authBackoff.failed(config.settings.intervalMs);
      logger.warn({ errorName: (error as Error).name }, "Billing mirror: Nextcloud unavailable.");
      return result("nextcloud_unavailable");
    }
    logger.error({ errorName: (error as Error)?.name }, "Billing mirror cycle failed.");
    return result("error");
  }
}

export interface BillingMirrorRunner {
  stop(): Promise<void>;
}

/**
 * Starts the loops, or returns null when the flag is off or the config invalid. Never throws.
 * Every `PORTAL_MIRROR_INTERVAL_MS`: refresh dirty snapshots, then mirror. At boot and every
 * `BILLING_SWEEP_INTERVAL_MS`: refresh every Customer (covers a missing webhook endpoint and
 * invoices that become overdue with no event), then mirror.
 */
export function startBillingMirror(
  logger: MirrorLogger,
  env: NodeJS.ProcessEnv = process.env
): BillingMirrorRunner | null {
  const config = loadBillingMirrorConfig(env);
  if (config.status === "disabled") return null;
  if (config.status === "invalid") {
    logger.error(
      { problems: config.problems },
      "Billing mirror is enabled but its config is invalid; not started."
    );
    return null;
  }

  let running: Promise<unknown> | null = null;
  let again = false;
  let sweepPending = false;
  let stopped = false;
  const run = () => {
    const all = sweepPending;
    sweepPending = false;
    again = false;
    running = (async () => {
      try {
        await runBillingRefresh({ logger, all });
      } catch (error) {
        logger.error({ errorName: (error as Error)?.name }, "Billing refresh crashed.");
      }
      await runBillingMirrorCycle({ logger, env });
    })()
      .catch((error: unknown) => {
        logger.error({ errorName: (error as Error)?.name }, "Billing mirror cycle crashed.");
      })
      .finally(() => {
        running = null;
        if (again && !stopped) run();
      });
  };
  const trigger = (sweep: boolean) => {
    if (stopped) return;
    sweepPending ||= sweep;
    if (running) {
      again = true;
      return;
    }
    run();
  };
  const timer = setInterval(() => trigger(false), config.settings.intervalMs);
  const sweepTimer = setInterval(() => trigger(true), config.settings.sweepIntervalMs);
  timer.unref();
  sweepTimer.unref();
  trigger(true);
  logger.info(
    {
      intervalMs: config.settings.intervalMs,
      sweepIntervalMs: config.settings.sweepIntervalMs,
      batch: config.settings.batch,
    },
    "Billing mirror started."
  );
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(sweepTimer);
      while (running) await running;
    },
  };
}
