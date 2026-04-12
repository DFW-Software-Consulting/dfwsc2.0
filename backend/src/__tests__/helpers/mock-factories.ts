import Stripe from "stripe";
import { vi } from "vitest";

// ─── Drizzle internals ────────────────────────────────────────────────────────

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function resolveTableName(table: any): string | undefined {
  if (!table) return undefined;
  if (typeof table.tableName === "string") return table.tableName;
  const sym = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof sym === "string" ? sym : undefined;
}

function isTable(table: any, name: string): boolean {
  return resolveTableName(table) === name;
}

function resolveColumnName(column: any): string | undefined {
  if (!column) return undefined;
  if (typeof column === "string") return column;
  if (typeof column.name === "string") return column.name;
  const columnName = (column as { columnName?: unknown }).columnName;
  if (typeof columnName === "string") return columnName;
  const sym = (column as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof sym === "string" ? sym : undefined;
}

function isColumn(column: any, name: string): boolean {
  const resolved = resolveColumnName(column);
  if (!resolved) return false;
  if (resolved === name) return true;
  const camelCased = name.replace(/_([a-z])/g, (_match, char) => char.toUpperCase());
  return resolved === camelCased;
}

function createWhereResult(rowsPromise: Promise<any[]>) {
  return {
    limit: async () => (await rowsPromise).slice(0, 1),
    then: rowsPromise.then.bind(rowsPromise),
    catch: rowsPromise.catch.bind(rowsPromise),
    finally: rowsPromise.finally.bind(rowsPromise),
  };
}

function chainable(rowsPromise: Promise<any[]>) {
  return {
    limit: (_n: number) => rowsPromise.then((rows) => rows.slice(0, _n)),
    then: rowsPromise.then.bind(rowsPromise),
    catch: rowsPromise.catch.bind(rowsPromise),
    finally: rowsPromise.finally.bind(rowsPromise),
  };
}

function filterByExpr(rows: any[], expr: any): any[] {
  if (!expr) return rows;
  if (expr.all?.length) {
    return rows.filter((r) => {
      return expr.all.every((cond: any) => {
        if (cond.field && cond.value !== undefined) {
          const colName = resolveColumnName(cond.field);
          if (!colName) return true;
          const camel = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
          return r[colName] === cond.value || r[camel] === cond.value;
        }
        return true;
      });
    });
  }
  if (expr.value !== undefined && expr.field !== undefined) {
    const colName = resolveColumnName(expr.field);
    if (!colName) return rows;
    return rows.filter((r) => {
      const camel = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return r[colName] === expr.value || r[camel] === expr.value;
    });
  }
  if (expr.values !== undefined && expr.field !== undefined) {
    const colName = resolveColumnName(expr.field);
    if (!colName) return rows;
    return rows.filter((r) => {
      const camel = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return expr.values.includes(r[colName]) || expr.values.includes(r[camel]);
    });
  }
  return rows;
}

// ─── DataStore types ──────────────────────────────────────────────────────────

export interface AppDataStore {
  clients: Map<string, any>;
  clientsByApiKey: Map<string, string>;
  onboardingTokens: Map<string, any>;
  webhookEvents: Map<string, any>;
  clientGroups: Map<string, any>;
  admins: Map<string, any>;
}

export interface InvoicesDataStore {
  clients: Map<string, any>;
}

// ─── App DB mock (used by app.test.ts) ───────────────────────────────────────

export function createAppDbMock(dataStore: AppDataStore) {
  function findOnboardingTokenByToken(token?: string) {
    if (!token) return undefined;
    for (const record of dataStore.onboardingTokens.values()) {
      if (record.token === token) return record;
    }
    return undefined;
  }

  function findClientByApiKey(apiKey?: string) {
    if (!apiKey) return undefined;
    const clientId = dataStore.clientsByApiKey.get(apiKey);
    if (clientId) return dataStore.clients.get(clientId);
    for (const client of dataStore.clients.values()) {
      if (client.apiKey === apiKey) return client;
    }
    return undefined;
  }

  const mock = {
    select: vi.fn(() => ({
      from: (table: any) => ({
        ...(() => {
          const rowsPromise = (async () => {
            if (isTable(table, "clients")) return Array.from(dataStore.clients.values());
            if (isTable(table, "onboarding_tokens"))
              return Array.from(dataStore.onboardingTokens.values());
            if (isTable(table, "webhook_events"))
              return Array.from(dataStore.webhookEvents.values());
            if (isTable(table, "client_groups")) return Array.from(dataStore.clientGroups.values());
            if (isTable(table, "admins")) return Array.from(dataStore.admins.values());
            return [];
          })();
          return {
            then: rowsPromise.then.bind(rowsPromise),
            catch: rowsPromise.catch.bind(rowsPromise),
            finally: rowsPromise.finally.bind(rowsPromise),
          };
        })(),
        where: (expr: any) => {
          const rowsPromise = (async () => {
            if (isTable(table, "clients")) {
              if (isColumn(expr?.field, "api_key")) {
                const client = findClientByApiKey(expr?.value);
                return client ? [client] : [];
              }
              if (expr?.isNull) {
                return Array.from(dataStore.clients.values()).filter(
                  (client) => client.apiKeyLookup == null
                );
              }
              if (isColumn(expr?.field, "group_id")) {
                return Array.from(dataStore.clients.values()).filter(
                  (c) => c.groupId === expr?.value
                );
              }
              if (isColumn(expr?.field, "workspace")) {
                return Array.from(dataStore.clients.values()).filter(
                  (c) => c.workspace === expr?.value
                );
              }
              if (expr?.all?.length) {
                const conditions = expr.all;
                return Array.from(dataStore.clients.values()).filter((c) => {
                  return conditions.every((cond: any) => {
                    if (isColumn(cond?.field, "group_id")) return c.groupId === cond?.value;
                    if (isColumn(cond?.field, "workspace")) return c.workspace === cond?.value;
                    return false;
                  });
                });
              }
              const row = dataStore.clients.get(expr?.value);
              return row ? [row] : [];
            }
            if (isTable(table, "client_groups")) {
              if (isColumn(expr?.field, "workspace")) {
                return Array.from(dataStore.clientGroups.values()).filter(
                  (g) => g.workspace === expr?.value
                );
              }
              const row = dataStore.clientGroups.get(expr?.value);
              return row ? [row] : [];
            }
            if (isTable(table, "admins")) {
              if (isColumn(expr?.field, "username")) {
                const row = Array.from(dataStore.admins.values()).find(
                  (a) => a.username === expr?.value
                );
                return row ? [row] : [];
              }
              const row = dataStore.admins.get(expr?.value);
              return row ? [row] : [];
            }
            if (isTable(table, "onboarding_tokens")) {
              if (expr?.all?.length) {
                const records = Array.from(dataStore.onboardingTokens.values());
                const matches = records.filter((record) =>
                  expr.all.every((condition: any) => {
                    if (!condition) return false;
                    if (isColumn(condition.field, "token")) return record.token === condition.value;
                    if (isColumn(condition.field, "status"))
                      return record.status === condition.value;
                    if (
                      isColumn(condition.field, "client_id") ||
                      isColumn(condition.field, "clientId")
                    )
                      return record.clientId === condition.value;
                    if (isColumn(condition.field, "state")) return record.state === condition.value;
                    return false;
                  })
                );
                return matches;
              }
              if (isColumn(expr?.field, "token")) {
                const record = findOnboardingTokenByToken(expr?.value);
                return record ? [record] : [];
              }
              const record = dataStore.onboardingTokens.get(expr?.value);
              return record ? [record] : [];
            }
            return [];
          })();
          return createWhereResult(rowsPromise);
        },
      }),
    })),
    insert: vi.fn((table: any) => ({
      values: (payload: any) => {
        if (isTable(table, "clients")) {
          const existing = dataStore.clients.get(payload.id);
          const apiKey = payload.apiKey ?? existing?.apiKey ?? null;
          const apiKeyHash =
            payload.apiKeyHash ?? existing?.apiKeyHash ?? (apiKey ? `hashed:${apiKey}` : null);
          const next = {
            id: payload.id,
            name: payload.name ?? existing?.name,
            email: payload.email ?? existing?.email,
            apiKey,
            apiKeyHash,
            status: payload.status ?? existing?.status ?? "active",
            stripeAccountId: payload.stripeAccountId ?? existing?.stripeAccountId ?? null,
            workspace: payload.workspace ?? existing?.workspace ?? "dfwsc_services",
            createdAt: existing?.createdAt ?? new Date(),
            updatedAt: new Date(),
          };
          dataStore.clients.set(payload.id, next);
          if (apiKey) dataStore.clientsByApiKey.set(apiKey, payload.id);
        }
        if (isTable(table, "webhook_events")) {
          if (!dataStore.webhookEvents.has(payload.stripeEventId)) {
            dataStore.webhookEvents.set(payload.stripeEventId, { ...payload });
          }
        }
        if (isTable(table, "onboarding_tokens")) {
          const next = {
            id: payload.id,
            clientId: payload.clientId,
            token: payload.token,
            status: payload.status ?? "pending",
            email: payload.email,
            state: payload.state ?? null,
            stateExpiresAt: payload.stateExpiresAt ?? null,
            createdAt: payload.createdAt ?? new Date(),
            updatedAt: new Date(),
          };
          dataStore.onboardingTokens.set(payload.id, next);
        }
        if (isTable(table, "client_groups")) {
          const next = {
            id: payload.id,
            name: payload.name,
            status: payload.status ?? "active",
            workspace: payload.workspace ?? "dfwsc_services",
            createdAt: payload.createdAt ?? new Date(),
            updatedAt: payload.updatedAt ?? new Date(),
          };
          dataStore.clientGroups.set(payload.id, next);
        }
        if (isTable(table, "admins")) {
          const next = {
            id: payload.id,
            username: payload.username,
            passwordHash: payload.passwordHash,
            role: payload.role ?? "admin",
            active: payload.active ?? true,
            setupConfirmed: payload.setupConfirmed ?? false,
            createdAt: payload.createdAt ?? new Date(),
            updatedAt: payload.updatedAt ?? new Date(),
          };
          dataStore.admins.set(payload.id, next);
        }
        return { onConflictDoNothing: async () => {} };
      },
    })),
    update: vi.fn((table: any) => ({
      set: (values: any) => ({
        where: (expr: any) => {
          const applyUpdate = () => {
            if (isTable(table, "clients")) {
              const row = dataStore.clients.get(expr.value);
              if (!row) return null;
              Object.assign(row, values);
              if (values.apiKey) dataStore.clientsByApiKey.set(values.apiKey, row.id);
              if (Object.hasOwn(values, "apiKeyHash")) row.apiKeyHash = values.apiKeyHash;
              return row;
            }
            if (isTable(table, "client_groups")) {
              const row = dataStore.clientGroups.get(expr.value);
              if (!row) return null;
              Object.assign(row, values);
              return row;
            }
            if (isTable(table, "onboarding_tokens")) {
              const row = dataStore.onboardingTokens.get(expr.value);
              if (!row) return null;
              Object.assign(row, values);
              return row;
            }
            if (isTable(table, "webhook_events")) {
              const row = dataStore.webhookEvents.get(expr.value);
              if (!row) return null;
              Object.assign(row, values);
              return row;
            }
            if (isTable(table, "admins")) {
              const row = dataStore.admins.get(expr.value);
              if (!row) return null;
              Object.assign(row, values);
              return row;
            }
            return null;
          };
          const resultPromise = Promise.resolve(applyUpdate());
          return {
            returning: async () => {
              const row = await resultPromise;
              return row ? [row] : [];
            },
            then: (resolve: any, reject: any) =>
              resultPromise
                .then((row) => (row ? { rowCount: 1 } : { rowCount: 0 }))
                .then(resolve, reject),
            catch: (reject: any) => resultPromise.catch(reject),
            finally: (cb: any) => resultPromise.finally(cb),
          };
        },
      }),
    })),
    transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mock)),
  };
  return mock;
}

// ─── Invoices DB mock (used by invoices.test.ts) ──────────────────────────────

export function createInvoicesDbMock(dataStore: InvoicesDataStore) {
  return {
    select: vi.fn((_fields?: any) => ({
      from: (table: any) => {
        const baseRows = isTable(table, "clients") ? Array.from(dataStore.clients.values()) : [];
        const basePromise = Promise.resolve(baseRows);
        return {
          leftJoin: (_joinTable: any, _on: any) => ({
            where: (expr: any) => chainable(Promise.resolve(filterByExpr(baseRows, expr))),
            then: basePromise.then.bind(basePromise),
          }),
          where: (expr: any) => chainable(Promise.resolve(filterByExpr(baseRows, expr))),
          then: basePromise.then.bind(basePromise),
          catch: basePromise.catch.bind(basePromise),
          finally: basePromise.finally.bind(basePromise),
        };
      },
    })),
    update: vi.fn((table: any) => ({
      set: (values: any) => ({
        where: (expr: any) => {
          const rows = isTable(table, "clients") ? Array.from(dataStore.clients.values()) : [];
          const targets = filterByExpr(rows, expr);
          for (const row of targets) Object.assign(row, values);
          return Promise.resolve(targets);
        },
      }),
    })),
  };
}

// ─── Stripe mock (used by app.test.ts) ───────────────────────────────────────

export function createStripeMock() {
  const webhookHelper = new Stripe("sk_test_12345", { apiVersion: "2023-10-16" });
  return {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    webhooks: webhookHelper.webhooks,
  };
}

// ─── Nodemailer mock factory ──────────────────────────────────────────────────

export function createNodemailerMock<T>(captureArray: T[], formatter: (opts: any) => T) {
  const sendMail = vi.fn(async (opts: any) => {
    captureArray.push(formatter(opts));
    return {};
  });
  const createTransport = () => ({ sendMail });
  return {
    __esModule: true,
    default: { createTransport },
    createTransport,
  };
}
