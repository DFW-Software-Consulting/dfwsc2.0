import { and, asc, eq, inArray, isNull, ne, notExists, or, type SQL, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, pool } from "../db/client";
import { clientGroups, clients, paymentLedger, portalMirrorRows } from "../db/schema";
import {
  getNextcloudConfig,
  NextcloudCircuitOpenError,
  type NextcloudConfig,
  NextcloudHttpError,
  NextcloudRequestError,
} from "./nextcloud";
import { PortalMirrorNextcloud } from "./portal-mirror-nextcloud";
import {
  ACCOUNTS_TABLE_TITLE,
  accountColumns,
  type ColumnSpec,
  cellMatches,
  contentHash,
  DEFAULT_MIRROR_OPTIONS,
  EMPTY_PAYMENT_SUMMARY,
  type FeeDefaults,
  type MirrorOptions,
  type PaymentSummary,
  type RenderedValues,
  renderAccount,
  toRowData,
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
// minus an overlap (updated_at is the transaction start, so a long transaction can commit late),
// or the latest updated_at among that client's payment_ledger rows is.
// Every Drizzle write bumps updated_at ($onUpdate); the daily reconcile also catches raw SQL and
// FK effects (a deleted group nulls clients.group_id without touching updated_at).
//
// Logs carry ids, counts, statuses and error names only.

type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

const KIND = "account" as const;
const PORTAL_MIRROR_DEFAULT_INTERVAL_MS = 60_000;
const PORTAL_MIRROR_MIN_INTERVAL_MS = 10_000;
const PORTAL_MIRROR_DEFAULT_BATCH = 25;
const PORTAL_MIRROR_MAX_BATCH = 100;
const OVERLAP_SECONDS = 5 * 60;
const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 60 * 60;
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

function intVar(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
  problems: string[]
): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return parsed;
}

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
  const rawGroups = env.PORTAL_MIRROR_SHARE_GROUPS?.trim();
  const shareGroups = rawGroups
    ? rawGroups
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean)
    : DEFAULT_SHARE_GROUPS;
  if (!shareGroups.length || shareGroups.some((g) => g.length > 64)) {
    problems.push("PORTAL_MIRROR_SHARE_GROUPS must list Nextcloud group names, comma separated");
  }
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
        includeEmail: env.PORTAL_MIRROR_INCLUDE_EMAIL?.trim() !== "false",
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

interface Provisioned {
  tableId: number;
  columnIds: Map<string, number>;
  specs: ColumnSpec[];
}

let provisioned: { signature: string; value: Provisioned } | null = null;
let lastReconcileAt = 0;
let lastLoggedProblem: string | null = null;
// A rejected app password (401/403) backs the mirror off, doubling from one interval to 30 min.
const MAX_AUTH_BACKOFF_MS = 30 * 60 * 1000;
const authBackoff = { failures: 0, until: 0 };

export function resetPortalMirrorStateForTests() {
  provisioned = null;
  lastReconcileAt = 0;
  lastLoggedProblem = null;
  authBackoff.failures = 0;
  authBackoff.until = 0;
}

function logProblemOnce(logger: Logger, key: string, fields: Record<string, unknown>, msg: string) {
  if (lastLoggedProblem === key) return;
  lastLoggedProblem = key;
  logger.error(fields, msg);
}

/** Misconfigured table (a hand-made one is missing columns). `detail` holds titles only. */
class PortalMirrorConfigError extends Error {
  constructor(readonly detail: string) {
    super(`Portal mirror misconfigured: ${detail}`);
    this.name = "PortalMirrorConfigError";
  }
}

/** Nextcloud as a whole is unusable right now: end the cycle instead of failing every row. */
function isOutage(error: unknown): boolean {
  return (
    error instanceof NextcloudCircuitOpenError ||
    error instanceof NextcloudRequestError ||
    (error instanceof NextcloudHttpError &&
      (error.status >= 500 || error.status === 429 || error.status === 401 || error.status === 403))
  );
}

const isAuthError = (error: unknown) =>
  error instanceof NextcloudHttpError && (error.status === 401 || error.status === 403);

// ── Provisioning ─────────────────────────────────────────────────────────────

async function provision(
  nc: PortalMirrorNextcloud,
  settings: PortalMirrorSettings
): Promise<Provisioned> {
  const specs = accountColumns(settings.options);
  const signature = JSON.stringify([
    settings.nextcloud.baseUrl,
    settings.accountsTableId,
    specs.map((s) => s.title),
    settings.shareGroups,
  ]);
  if (provisioned?.signature === signature) return provisioned.value;

  let tableId = settings.accountsTableId;
  if (tableId === null) {
    const tables = await nc.listTables();
    const mine = tables.find(
      (t) =>
        t.title === ACCOUNTS_TABLE_TITLE &&
        (t.ownership === null || t.ownership === nc.serviceUsername)
    );
    tableId = mine ? mine.id : await nc.createTable(ACCOUNTS_TABLE_TITLE, "📊");
  }

  let columns = await nc.getColumns(tableId);
  const byTitle = new Map(columns.map((c) => [c.title.trim(), c.id]));
  const missing = specs.filter((s) => !byTitle.has(s.title));
  if (missing.length) {
    if (settings.accountsTableId !== null) {
      throw new PortalMirrorConfigError(
        `table ${tableId} lacks columns: ${missing.map((m) => m.title).join(", ")}`
      );
    }
    // Columns are created in order, so the table reads left to right as specified.
    for (const spec of missing) byTitle.set(spec.title, await nc.createColumn(tableId, spec));
    columns = [];
  }

  if (settings.accountsTableId === null) {
    const shares = await nc.listShares(tableId);
    for (const group of settings.shareGroups) {
      if (!shares.some((s) => s.receiver === group && s.receiverType === "group")) {
        await nc.shareReadOnly(tableId, group);
      }
    }
  }

  const value: Provisioned = {
    tableId,
    columnIds: new Map(specs.map((s) => [s.key, byTitle.get(s.title) as number])),
    specs,
  };
  provisioned = { signature, value };
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

const retrySeconds = (attempts: number) =>
  Math.min(RETRY_BASE_SECONDS * 2 ** Math.min(attempts, 20), RETRY_MAX_SECONDS);

async function saveMapping(
  sourceId: string,
  patch: {
    ncRowId: number | null;
    contentHash: string | null;
    syncedAt: Date | null;
  }
) {
  const set = {
    ...patch,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    updatedAt: new Date(),
  };
  await db
    .insert(m)
    .values({ kind: KIND, sourceId, ...set })
    .onConflictDoUpdate({ target: [m.kind, m.sourceId], set });
}

async function recordFailure(sourceId: string, attempts: number, error: unknown) {
  const name = (error as Error)?.name ?? "Error";
  const status = error instanceof NextcloudHttpError ? `:${error.status}` : "";
  const next = new Date(Date.now() + retrySeconds(attempts) * 1000);
  await db
    .insert(m)
    .values({
      kind: KIND,
      sourceId,
      attempts: attempts + 1,
      nextAttemptAt: next,
      lastError: `${name}${status}`.slice(0, 200),
    })
    .onConflictDoUpdate({
      target: [m.kind, m.sourceId],
      set: {
        attempts: attempts + 1,
        nextAttemptAt: next,
        lastError: `${name}${status}`.slice(0, 200),
        updatedAt: new Date(),
      },
    });
}

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
  // Latest payment change per client: a payment insert or webhook update re-renders the row.
  // payment_ledger_client_id_idx covers the grouping; the ledger is small, so no extra index.
  const pay = db
    .select({
      clientId: paymentLedger.clientId,
      lastChange: sql<Date>`max(${paymentLedger.updatedAt})`.as("last_change"),
    })
    .from(paymentLedger)
    .groupBy(paymentLedger.clientId)
    .as("pay");
  const dirty = await db
    .select({ client: clients, group: clientGroups, mirror: m })
    .from(clients)
    .leftJoin(clientGroups, eq(clientGroups.id, clients.groupId))
    .leftJoin(pay, eq(pay.clientId, clients.id))
    .leftJoin(m, and(eq(m.kind, KIND), eq(m.sourceId, clients.id)))
    .where(
      and(
        mirroredClients(settings.options),
        or(
          isNull(m.sourceId),
          isNull(m.syncedAt),
          sql`greatest(${clients.updatedAt}, coalesce(${clientGroups.updatedAt}, '-infinity'::timestamptz), coalesce(${pay.lastChange}, '-infinity'::timestamptz)) >= ${m.syncedAt} - make_interval(secs => ${OVERLAP_SECONDS})`
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
      settings.options,
      summaries.get(row.client.id) ?? EMPTY_PAYMENT_SUMMARY
    );
    const hash = contentHash(values);
    const sourceId = row.client.id;
    const ncRowId = row.mirror?.ncRowId ?? null;
    try {
      if (ncRowId !== null && row.mirror?.contentHash === hash) {
        await saveMapping(sourceId, { ncRowId, contentHash: hash, syncedAt: cycleStart });
        out.unchanged += 1;
        continue;
      }
      const data = toRowData(prov.specs, prov.columnIds, values);
      let savedId = ncRowId;
      if (savedId !== null) {
        try {
          await nc.updateRow(savedId, data);
          out.updated += 1;
        } catch (error) {
          // 404: the row was deleted in Nextcloud. Put it back.
          if (!(error instanceof NextcloudHttpError && error.status === 404)) throw error;
          savedId = null;
        }
      }
      if (savedId === null) {
        savedId = await nc.createRow(prov.tableId, data);
        out.created += 1;
      }
      await saveMapping(sourceId, { ncRowId: savedId, contentHash: hash, syncedAt: cycleStart });
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
  const keyColumn = prov.columnIds.get("id") as number;
  const ncRows = await nc.listRows(prov.tableId);

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
        settings.options,
        summaries.get(s.client.id) ?? EMPTY_PAYMENT_SUMMARY
      ),
    ])
  );
  const mapping = new Map(
    (await db.select().from(m).where(eq(m.kind, KIND))).map((r) => [r.sourceId, r])
  );

  const byKey = new Map<string, typeof ncRows>();
  for (const row of ncRows) {
    const key = String(row.cells.get(keyColumn) ?? "");
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  for (const [key, rows] of byKey) {
    if (!expected.has(key)) {
      for (const row of rows) await nc.deleteRow(row.id);
      continue;
    }
    const mapped = mapping.get(key)?.ncRowId;
    const keeper =
      rows.find((r) => r.id === mapped) ?? rows.reduce((a, b) => (a.id < b.id ? a : b));
    for (const row of rows) if (row !== keeper) await nc.deleteRow(row.id);
  }

  for (const [key, values] of expected) {
    const keeper =
      (byKey.get(key) ?? []).find((r) => r.id === mapping.get(key)?.ncRowId) ??
      (byKey.get(key) ?? []).reduce<(typeof ncRows)[number] | null>(
        (a, b) => (a && a.id < b.id ? a : b),
        null
      );
    if (!keeper) {
      await saveMapping(key, { ncRowId: null, contentHash: null, syncedAt: null });
      continue;
    }
    const drifted = prov.specs.some(
      (spec) =>
        !cellMatches(
          spec,
          keeper.cells.get(prov.columnIds.get(spec.key) as number),
          values[spec.key]
        )
    );
    if (drifted) {
      await saveMapping(key, { ncRowId: keeper.id, contentHash: null, syncedAt: null });
    } else if (mapping.get(key)?.ncRowId !== keeper.id || !mapping.get(key)?.contentHash) {
      await saveMapping(key, {
        ncRowId: keeper.id,
        contentHash: contentHash(values),
        syncedAt: cycleStart,
      });
    }
  }
}

async function syncOnce(
  settings: PortalMirrorSettings,
  logger: Logger,
  cycleStart: Date
): Promise<PortalMirrorResult> {
  const nc = new PortalMirrorNextcloud(settings.nextcloud, settings.minGapMs);
  const out = result("ok");
  const ctx: CycleContext = { warnedNonUsd: false };
  const prov = await provision(nc, settings);
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
    const client = await pool.connect();
    let outcome: PortalMirrorResult;
    // A connection that may still hold the advisory lock is destroyed, never pooled.
    let destroyClient = false;
    try {
      const lock = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
        [CYCLE_LOCK_NAME]
      );
      if (!lock.rows[0]?.ok) return result("busy");
      try {
        // Database clock, taken before any read.
        const started = await client.query<{ now: Date }>("SELECT now() AS now");
        outcome = await syncOnce(config.settings, logger, started.rows[0].now);
      } finally {
        try {
          const unlock = await client.query<{ ok: boolean }>(
            "SELECT pg_advisory_unlock(hashtext($1)) AS ok",
            [CYCLE_LOCK_NAME]
          );
          destroyClient = !unlock.rows[0]?.ok;
        } catch {
          destroyClient = true;
        }
        if (destroyClient) {
          logger.error({}, "Portal mirror could not release its cycle lock; connection discarded.");
        }
      }
    } finally {
      client.release(destroyClient);
    }
    if (outcome.status === "ok") {
      lastLoggedProblem = null;
      authBackoff.failures = 0;
    }
    return outcome;
  } catch (error) {
    if (error instanceof PortalMirrorConfigError) {
      logProblemOnce(logger, `config:${error.detail}`, { detail: error.detail }, error.message);
      return result("invalid_config");
    }
    if (isOutage(error)) {
      if (isAuthError(error)) {
        authBackoff.failures += 1;
        authBackoff.until =
          Date.now() +
          Math.min(
            config.settings.intervalMs * 2 ** (authBackoff.failures - 1),
            MAX_AUTH_BACKOFF_MS
          );
      }
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
