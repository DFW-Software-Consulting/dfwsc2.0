import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { db } from "../db/client";
import { clientGroups, clients, paymentLedger, portalMirrorRows } from "../db/schema";
import {
  AuthBackoff,
  intVar,
  isAuthError,
  isOutage,
  type MirrorLogger,
  PortalMirrorConfigError,
  type ProvisionCache,
  type Provisioned,
  parseShareGroups,
  provisionMirrorTable,
  pushMirrorRow,
  reconcileMirrorRows,
  recordMirrorFailure,
  withMirrorLock,
} from "./mirror-table";
import { getNextcloudConfig, type NextcloudConfig } from "./nextcloud";
import { PortalMirrorNextcloud } from "./portal-mirror-nextcloud";
import {
  ACCOUNTS_TABLE_TITLE,
  accountColumns,
  DEFAULT_MIRROR_OPTIONS,
  EMPTY_PAYMENT_SUMMARY,
  type FeeDefaults,
  type MirrorOptions,
  type PaymentSummary,
  type RenderedValues,
  renderAccount,
} from "./portal-mirror-render";
import { getSettings } from "./stripe-billing";

// Read-only mirror of the Stripe Connect side of the portal (the `clients` table) into a
// Nextcloud Table, "Portal Accounts", so the owner and managers can see status without logging
// in to Stripe or the admin panel. Off unless PORTAL_MIRROR=true. The database is the source of
// truth: edits made in Nextcloud are overwritten. Payments are NOT mirrored row by row; each
// account only carries payment aggregates (Last Payment, Payments (30d), DFWSC Fees (30d)).
//
// Change tracking needs no trigger and no column on `clients`: a client is dirty when it has no
// portal_mirror_rows row, or its updated_at (or its group's) is newer than the row's synced_at
// minus an overlap, or any of that client's payment_ledger rows changed after that point.
// updated_at comes from two clocks: Drizzle's $onUpdate stamps the API's Node clock when the
// statement is built, a plain INSERT stamps the database's now() (transaction start), while
// synced_at is the database clock at the start of a cycle. Clock skew and a transaction that
// commits some time after its stamp can therefore put a committed write slightly BEFORE a
// synced_at taken later. The 5 minute overlap absorbs both; anything older is caught by the
// daily reconcile.
// Every Drizzle write bumps updated_at ($onUpdate); the daily reconcile also catches raw SQL and
// FK effects (a deleted group nulls clients.group_id without touching updated_at).
//
// Logs carry ids, counts, statuses and error names only.

type Logger = MirrorLogger;

const KIND = "account" as const;
const PORTAL_MIRROR_DEFAULT_INTERVAL_MS = 60_000;
const PORTAL_MIRROR_MIN_INTERVAL_MS = 10_000;
const PORTAL_MIRROR_DEFAULT_BATCH = 25;
const PORTAL_MIRROR_MAX_BATCH = 100;
const OVERLAP_SECONDS = 5 * 60;
const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
const CYCLE_LOCK_NAME = "portal_mirror_cycle";
const DEFAULT_SHARE_GROUPS = ["dfwsc-admins", "managers"];

interface PortalMirrorSettings {
  nextcloud: NextcloudConfig;
  intervalMs: number;
  batch: number;
  shareGroups: string[];
  /** Hand-made table (fallback): its columns must exist and it is not shared by the API. */
  accountsTableId: number | null;
  options: MirrorOptions;
  /** Minimum gap between Nextcloud calls (200 = 5 per second). */
  minGapMs: number;
}

type ConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; problems: string[] }
  | { status: "ready"; settings: PortalMirrorSettings };

export function loadPortalMirrorConfig(env: NodeJS.ProcessEnv): ConfigResult {
  if (env.PORTAL_MIRROR?.trim() !== "true") return { status: "disabled" };
  const problems: string[] = [];
  const nc = getNextcloudConfig(env);
  if (!nc.ok) {
    problems.push(
      nc.reason === "not_configured"
        ? "NEXTCLOUD_BASE_URL, NEXTCLOUD_USERNAME and NEXTCLOUD_APP_PASSWORD are required"
        : "NEXTCLOUD_BASE_URL must be a valid https:// URL"
    );
  }
  const intervalMs = intVar(
    env.PORTAL_MIRROR_INTERVAL_MS,
    "PORTAL_MIRROR_INTERVAL_MS",
    PORTAL_MIRROR_MIN_INTERVAL_MS,
    24 * 60 * 60 * 1000,
    PORTAL_MIRROR_DEFAULT_INTERVAL_MS,
    problems
  );
  const batch = intVar(
    env.PORTAL_MIRROR_BATCH,
    "PORTAL_MIRROR_BATCH",
    1,
    PORTAL_MIRROR_MAX_BATCH,
    PORTAL_MIRROR_DEFAULT_BATCH,
    problems
  );
  const accountsTableId = env.PORTAL_ACCOUNTS_TABLE_ID?.trim()
    ? intVar(env.PORTAL_ACCOUNTS_TABLE_ID, "PORTAL_ACCOUNTS_TABLE_ID", 1, 2 ** 31 - 1, 0, problems)
    : null;
  const shareGroups = parseShareGroups(
    env.PORTAL_MIRROR_SHARE_GROUPS,
    "PORTAL_MIRROR_SHARE_GROUPS",
    DEFAULT_SHARE_GROUPS,
    problems
  );
  if (!nc.ok || problems.length) return { status: "invalid", problems };
  return {
    status: "ready",
    settings: {
      nextcloud: nc.config,
      intervalMs,
      batch,
      shareGroups,
      accountsTableId,
      options: {
        ...DEFAULT_MIRROR_OPTIONS,
        includeArchived: env.PORTAL_MIRROR_INCLUDE_ARCHIVED?.trim() === "true",
      },
      minGapMs: 200,
    },
  };
}

// ── State ────────────────────────────────────────────────────────────────────

export interface PortalMirrorResult {
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
  status: PortalMirrorResult["status"],
  extra: Partial<PortalMirrorResult> = {}
): PortalMirrorResult => ({
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

export function resetPortalMirrorStateForTests() {
  provisionCache.current = null;
  lastReconcileAt = 0;
  lastLoggedProblem = null;
  authBackoff.reset();
}

function logProblemOnce(logger: Logger, key: string, fields: Record<string, unknown>, msg: string) {
  if (lastLoggedProblem === key) return;
  lastLoggedProblem = key;
  logger.error(fields, msg);
}

// ── Provisioning ─────────────────────────────────────────────────────────────

const TABLE_ID_KEY = "accounts_table_id";

async function provision(
  nc: PortalMirrorNextcloud,
  settings: PortalMirrorSettings,
  logger: Logger
): Promise<Provisioned> {
  const { value, changed } = await provisionMirrorTable(
    nc,
    {
      title: ACCOUNTS_TABLE_TITLE,
      emoji: "📊",
      stateKey: TABLE_ID_KEY,
      specs: accountColumns(),
      shareGroups: settings.shareGroups,
      baseUrl: settings.nextcloud.baseUrl,
      overrideTableId: settings.accountsTableId,
    },
    provisionCache,
    logger
  );
  if (changed) lastReconcileAt = 0; // rows or cells may be missing: reconcile this cycle
  return value;
}

// ── Queries ──────────────────────────────────────────────────────────────────

const m = portalMirrorRows;

/** The one switch for archived clients: they are not mirrored and their row is removed. */
function mirroredClients(options: MirrorOptions): SQL | undefined {
  return options.includeArchived ? undefined : ne(clients.status, "archived");
}

async function feeDefaults(): Promise<FeeDefaults> {
  // Same fallbacks as resolveClientFee (lib/stripe-billing.ts).
  const s = await getSettings();
  const percent = s.default_fee_percent ?? null;
  const cents = s.default_fee_cents
    ? parseInt(s.default_fee_cents, 10)
    : Number(process.env.DEFAULT_PROCESS_FEE_CENTS ?? 0);
  return { percent, cents };
}

// A payment counts toward the account summary when it is paid, or refunded only in part (the
// ledger's `refunded` status covers full and partial refunds). See PaymentSummary.
const COUNTED = sql`(${paymentLedger.status} = 'paid' OR (${paymentLedger.status} = 'refunded' AND ${paymentLedger.refundedAmountCents} < ${paymentLedger.totalAmountCents}))`;
const IS_USD = sql`lower(${paymentLedger.currency}) = 'usd'`;

interface CycleContext {
  warnedNonUsd: boolean;
}

/**
 * Payment aggregates per client (all of them when `clientIds` is null), computed in SQL. Only
 * aggregates leave the database. The 30 day window is relative to the cycle's database clock.
 */
async function loadPaymentSummaries(
  clientIds: string[] | null,
  cycleStart: Date,
  logger: Logger,
  ctx: CycleContext
): Promise<Map<string, PaymentSummary>> {
  if (clientIds !== null && clientIds.length === 0) return new Map();
  const inWindow = sql`${paymentLedger.createdAt} >= ${cycleStart}::timestamptz - interval '30 days'`;
  const rows = await db
    .select({
      clientId: paymentLedger.clientId,
      lastPayment: sql<
        Date | string | null
      >`max(${paymentLedger.createdAt}) FILTER (WHERE ${COUNTED})`,
      payments30d: sql<number>`count(*) FILTER (WHERE ${COUNTED} AND ${inWindow})::int`,
      fees30dCents: sql<number>`coalesce(sum(${paymentLedger.feeAmountCents}) FILTER (WHERE ${COUNTED} AND ${inWindow} AND ${IS_USD}), 0)::int`,
      nonUsd30d: sql<number>`count(*) FILTER (WHERE ${COUNTED} AND ${inWindow} AND NOT ${IS_USD})::int`,
    })
    .from(paymentLedger)
    .where(clientIds === null ? undefined : inArray(paymentLedger.clientId, clientIds))
    .groupBy(paymentLedger.clientId);
  const out = new Map<string, PaymentSummary>();
  let nonUsdClients = 0;
  for (const r of rows) {
    if (r.nonUsd30d > 0) nonUsdClients += 1;
    out.set(r.clientId, {
      lastPayment: r.lastPayment ? new Date(r.lastPayment) : null,
      payments30d: r.payments30d,
      fees30dCents: r.fees30dCents,
    });
  }
  if (nonUsdClients > 0 && !ctx.warnedNonUsd) {
    ctx.warnedNonUsd = true;
    logger.warn(
      { clients: nonUsdClients },
      "Portal mirror: non-USD payments are left out of the DFWSC Fees (30d) column."
    );
  }
  return out;
}

const recordFailure = (sourceId: string, attempts: number, error: unknown) =>
  recordMirrorFailure(KIND, sourceId, attempts, error);

// ── Cycle ────────────────────────────────────────────────────────────────────

async function syncDirtyAccounts(
  nc: PortalMirrorNextcloud,
  prov: Provisioned,
  settings: PortalMirrorSettings,
  logger: Logger,
  cycleStart: Date,
  out: PortalMirrorResult,
  ctx: CycleContext
): Promise<void> {
  const defaults = await feeDefaults();
  const dirty = await db
    .select({ client: clients, group: clientGroups, mirror: m })
    .from(clients)
    .leftJoin(clientGroups, eq(clientGroups.id, clients.groupId))
    .leftJoin(m, and(eq(m.kind, KIND), eq(m.sourceId, clients.id)))
    .where(
      and(
        mirroredClients(settings.options),
        or(
          isNull(m.sourceId),
          isNull(m.syncedAt),
          sql`greatest(${clients.updatedAt}, coalesce(${clientGroups.updatedAt}, '-infinity'::timestamptz)) >= ${m.syncedAt} - make_interval(secs => ${OVERLAP_SECONDS})`,
          // A payment of this client changed since the row was written: an index range probe on
          // payment_ledger_client_updated_idx, not an aggregate over the whole ledger.
          exists(
            db
              .select({ one: sql`1` })
              .from(paymentLedger)
              .where(
                and(
                  eq(paymentLedger.clientId, clients.id),
                  sql`${paymentLedger.updatedAt} >= ${m.syncedAt} - make_interval(secs => ${OVERLAP_SECONDS})`
                )
              )
          )
        ),
        or(isNull(m.nextAttemptAt), sql`${m.nextAttemptAt} <= now()`)
      )
    )
    .orderBy(sql`${m.syncedAt} ASC NULLS FIRST`, asc(clients.createdAt))
    .limit(settings.batch);

  const summaries = await loadPaymentSummaries(
    dirty.map((d) => d.client.id),
    cycleStart,
    logger,
    ctx
  );
  let remaining = settings.batch;
  for (const row of dirty) {
    remaining -= 1;
    const values: RenderedValues = renderAccount(
      row.client,
      row.group,
      defaults,
      summaries.get(row.client.id) ?? EMPTY_PAYMENT_SUMMARY
    );
    const sourceId = row.client.id;
    try {
      out[await pushMirrorRow(nc, prov, KIND, sourceId, values, row.mirror, cycleStart)] += 1;
    } catch (error) {
      if (isOutage(error)) throw error;
      out.failed += 1;
      logger.warn(
        { clientId: sourceId, errorName: (error as Error)?.name },
        "Portal mirror could not write a row; will retry with backoff."
      );
      await recordFailure(sourceId, row.mirror?.attempts ?? 0, error);
    }
  }

  // Rows whose client is gone (or archived and hidden): remove from Nextcloud, then forget.
  if (remaining <= 0) return;
  const stale = await db
    .select()
    .from(m)
    .where(
      and(
        eq(m.kind, KIND),
        or(isNull(m.nextAttemptAt), sql`${m.nextAttemptAt} <= now()`),
        notExists(
          db
            .select({ one: sql`1` })
            .from(clients)
            .where(and(eq(clients.id, m.sourceId), mirroredClients(settings.options)))
        )
      )
    )
    .limit(remaining);
  for (const row of stale) {
    try {
      if (row.ncRowId !== null) await nc.deleteRow(row.ncRowId);
      await db.delete(m).where(and(eq(m.kind, KIND), eq(m.sourceId, row.sourceId)));
      out.deleted += 1;
    } catch (error) {
      if (isOutage(error)) throw error;
      out.failed += 1;
      await recordFailure(row.sourceId, row.attempts, error);
    }
  }
}

/**
 * Compares the Nextcloud table with the database and repairs drift. Rows missing or edited in
 * Nextcloud are marked dirty (the normal loop rewrites them within its batch limit); rows with no
 * source, or duplicates of one source id, are deleted.
 */
async function reconcileAccounts(
  nc: PortalMirrorNextcloud,
  prov: Provisioned,
  settings: PortalMirrorSettings,
  cycleStart: Date,
  logger: Logger,
  ctx: CycleContext
): Promise<void> {
  const defaults = await feeDefaults();
  // Every account is re-rendered: the 30 day window slides with no write at all, so only this
  // recompute notices a payment that aged out. The content hash keeps unchanged rows a no-op.
  const summaries = await loadPaymentSummaries(null, cycleStart, logger, ctx);
  const sources = await db
    .select({ client: clients, group: clientGroups })
    .from(clients)
    .leftJoin(clientGroups, eq(clientGroups.id, clients.groupId))
    .where(mirroredClients(settings.options));
  const expected = new Map<string, RenderedValues>(
    sources.map((s) => [
      s.client.id,
      renderAccount(
        s.client,
        s.group,
        defaults,
        summaries.get(s.client.id) ?? EMPTY_PAYMENT_SUMMARY
      ),
    ])
  );
  await reconcileMirrorRows(nc, prov, KIND, "id", expected, cycleStart);
}

async function syncOnce(
  settings: PortalMirrorSettings,
  logger: Logger,
  cycleStart: Date
): Promise<PortalMirrorResult> {
  const nc = new PortalMirrorNextcloud(settings.nextcloud, settings.minGapMs);
  const out = result("ok");
  const ctx: CycleContext = { warnedNonUsd: false };
  const prov = await provision(nc, settings, logger);
  if (Date.now() - lastReconcileAt >= RECONCILE_EVERY_MS) {
    await reconcileAccounts(nc, prov, settings, cycleStart, logger, ctx);
    lastReconcileAt = Date.now();
    out.reconciled = true;
  }
  await syncDirtyAccounts(nc, prov, settings, logger, cycleStart, out, ctx);
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
      "Portal mirror cycle finished."
    );
  }
  return out;
}

export async function runPortalMirrorCycle(options: {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  /** Tests only: overrides the 200 ms spacing between Nextcloud calls. */
  minGapMs?: number;
}): Promise<PortalMirrorResult> {
  const { logger, env = process.env } = options;
  const config = loadPortalMirrorConfig(env);
  if (config.status === "disabled") return result("disabled");
  if (config.status === "ready" && options.minGapMs !== undefined) {
    config.settings.minGapMs = options.minGapMs;
  }
  if (config.status === "invalid") {
    logProblemOnce(
      logger,
      `invalid:${config.problems.join("|")}`,
      { problems: config.problems },
      "Portal mirror is enabled but its config is invalid; skipped."
    );
    return result("invalid_config");
  }
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
        "Portal mirror misconfigured."
      );
      return result("invalid_config");
    }
    if (isOutage(error)) {
      if (isAuthError(error)) authBackoff.failed(config.settings.intervalMs);
      logger.warn({ errorName: (error as Error).name }, "Portal mirror: Nextcloud unavailable.");
      return result("nextcloud_unavailable");
    }
    logger.error({ errorName: (error as Error)?.name }, "Portal mirror cycle failed.");
    return result("error");
  }
}

export interface PortalMirrorRunner {
  trigger(): void;
  stop(): Promise<void>;
}

/** Starts the interval loop, or returns null when the flag is off or the config invalid. Never throws. */
export function startPortalMirror(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env
): PortalMirrorRunner | null {
  const config = loadPortalMirrorConfig(env);
  if (config.status === "disabled") return null;
  if (config.status === "invalid") {
    logger.error(
      { problems: config.problems },
      "Portal mirror is enabled but its config is invalid; not started."
    );
    return null;
  }

  let running: Promise<unknown> | null = null;
  let again = false;
  let stopped = false;
  const run = () => {
    running = runPortalMirrorCycle({ logger, env })
      .catch((error: unknown) => {
        logger.error({ errorName: (error as Error)?.name }, "Portal mirror cycle crashed.");
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
  const timer = setInterval(trigger, config.settings.intervalMs);
  timer.unref();
  trigger();
  logger.info(
    { intervalMs: config.settings.intervalMs, batch: config.settings.batch },
    "Portal mirror started."
  );
  return {
    trigger,
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (running) await running;
    },
  };
}
