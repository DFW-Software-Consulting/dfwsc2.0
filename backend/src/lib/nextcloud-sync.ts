import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clients, invoiceSyncState, profileSyncState } from "../db/schema";
import { isCrmWorkspace } from "./workspace";

/**
 * Nextcloud OpenRegister Sync Integration
 *
 * API Base: https://cloud.dfwsc.com/index.php/apps/openregister/api/objects/{registerId}/{schemaId}
 *
 * Outbound (DFWSC → OpenRegister):
 *   POST   /{registerId}/{schemaId}                      → create object
 *   PUT    /{registerId}/{schemaId}/{externalId}          → update object
 *
 * Inbound (OpenRegister → DFWSC) via polling:
 *   GET    /{registerId}/{schemaId}?_modified=gt:{isoDate} → list modified objects
 *
 * Auth: Basic auth with Nextcloud app password (NEXTCLOUD_USERNAME + NEXTCLOUD_APP_PASSWORD)
 *
 * Register/Schema IDs obtained from:
 *   curl "https://cloud.dfwsc.com/index.php/apps/pipelinq/api/settings" \
 *     -u dfwsc-admin:<app-password> -H "OCS-APIREQUEST: true"
 *
 * Webhook signature: SHA256(rawBody + NEXTCLOUD_WEBHOOK_SECRET) via X-Nextcloud-Webhooks header
 */

type SyncStatus = "synced" | "pending" | "failed";

export interface SyncStateRecord {
  clientId: string;
  syncStatus: SyncStatus;
  syncError: string | null;
  syncAttempts: number;
  lastSyncAttemptAt: string | null;
  lastSyncedAt: string | null;
  externalId: string | null;
}

export interface InvoiceSyncStateRecord {
  stripeInvoiceId: string;
  clientId: string;
  syncStatus: SyncStatus;
  syncError: string | null;
  syncAttempts: number;
  lastSyncAttemptAt: string | null;
  lastSyncedAt: string | null;
  externalId: string | null;
}

interface NextcloudProfilePayload {
  externalId?: string | null;
  workspace: "dfwsc_services";
  companyName: string;
  contactName: string;
  contactEmail: string;
  status: "lead" | "client" | "inactive";
  phone?: string | null;
  notes?: string | null;
}

interface OpenRegisterPayload {
  name: string;
  type: "person" | "organization";
  email?: string;
  phone?: string;
  notes?: string;
  status?: string;
  _dfwsc_client_id?: string;
  _dfwsc_workspace?: string;
  _dfwsc_contact_name?: string;
}

interface NextcloudLedgerLineItem {
  description: string;
  amountCents: number;
  quantity: number | null;
  currency: string;
}

export interface NextcloudLedgerInvoiceInput {
  stripeInvoiceId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  workspace: "dfwsc_services" | "client_portal";
  status: string;
  currency: string;
  amountDueCents: number;
  subtotalCents: number;
  taxCents: number;
  amountPaidCents: number;
  amountRemainingCents: number;
  description: string;
  dueDateIso: string | null;
  paidAtIso: string | null;
  hostedInvoiceUrl: string | null;
  createdAtIso: string;
  paymentMethod: string | null;
  paymentReference: string | null;
  lineItems: NextcloudLedgerLineItem[];
}

interface NextcloudLedgerPayload extends NextcloudLedgerInvoiceInput {
  externalId?: string | null;
}

interface OpenRegisterLedgerPayload {
  name: string;
  type: "invoice";
  stripe_invoice_id: string;
  client_name: string;
  client_email: string;
  _dfwsc_client_id: string;
  _dfwsc_workspace: string;
  status: string;
  currency: string;
  amount_due_cents: number;
  subtotal_cents: number;
  tax_cents: number;
  amount_paid_cents: number;
  amount_remaining_cents: number;
  description?: string;
  due_date?: string;
  paid_at?: string;
  created_at: string;
  hosted_invoice_url?: string;
  payment_method?: string;
  payment_reference?: string;
  line_items_json?: string;
}

function toOpenRegisterPayload(payload: NextcloudProfilePayload): OpenRegisterPayload {
  return {
    name: payload.companyName,
    type: "organization",
    email: payload.contactEmail,
    phone: payload.phone ?? undefined,
    notes: payload.notes ?? undefined,
    status: payload.status,
    _dfwsc_client_id: payload.externalId ?? undefined,
    _dfwsc_workspace: payload.workspace,
    _dfwsc_contact_name: payload.contactName ?? undefined,
  };
}

function toOpenRegisterLedgerPayload(payload: NextcloudLedgerPayload): OpenRegisterLedgerPayload {
  return {
    name: `Invoice ${payload.stripeInvoiceId}`,
    type: "invoice",
    stripe_invoice_id: payload.stripeInvoiceId,
    client_name: payload.clientName,
    client_email: payload.clientEmail,
    _dfwsc_client_id: payload.clientId,
    _dfwsc_workspace: payload.workspace,
    status: payload.status,
    currency: payload.currency,
    amount_due_cents: payload.amountDueCents,
    subtotal_cents: payload.subtotalCents,
    tax_cents: payload.taxCents,
    amount_paid_cents: payload.amountPaidCents,
    amount_remaining_cents: payload.amountRemainingCents,
    description: payload.description || undefined,
    due_date: payload.dueDateIso ?? undefined,
    paid_at: payload.paidAtIso ?? undefined,
    created_at: payload.createdAtIso,
    hosted_invoice_url: payload.hostedInvoiceUrl ?? undefined,
    payment_method: payload.paymentMethod ?? undefined,
    payment_reference: payload.paymentReference ?? undefined,
    line_items_json:
      payload.lineItems.length > 0 ? JSON.stringify(payload.lineItems).slice(0, 10_000) : undefined,
  };
}

export function toNextcloudLedgerInvoiceInput(
  invoice: Stripe.Invoice,
  client: { id: string; name: string; email: string; workspace: string }
): NextcloudLedgerInvoiceInput {
  const lineItems = (invoice.lines?.data ?? []).map((line) => ({
    description: line.description ?? "",
    amountCents: line.amount ?? 0,
    quantity: typeof line.quantity === "number" ? line.quantity : null,
    currency: line.currency ?? invoice.currency ?? "usd",
  }));

  const totalTax = (invoice.total_taxes ?? []).reduce((sum: number, taxAmount) => {
    return sum + (taxAmount.amount ?? 0);
  }, 0);

  return {
    stripeInvoiceId: invoice.id,
    clientId: client.id,
    clientName: client.name,
    clientEmail: client.email,
    workspace: client.workspace === "dfwsc_services" ? "dfwsc_services" : "client_portal",
    status: invoice.status ?? "draft",
    currency: invoice.currency ?? "usd",
    amountDueCents: invoice.amount_due ?? 0,
    subtotalCents: invoice.subtotal ?? 0,
    taxCents: totalTax,
    amountPaidCents: invoice.amount_paid ?? 0,
    amountRemainingCents: invoice.amount_remaining ?? 0,
    description: invoice.description ?? "",
    dueDateIso: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null,
    paidAtIso: invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      : null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    createdAtIso: new Date(invoice.created * 1000).toISOString(),
    paymentMethod:
      invoice.metadata?.paidOutOfBand === "true"
        ? (invoice.metadata?.paymentMethod ?? null)
        : invoice.status === "paid"
          ? "stripe"
          : null,
    paymentReference: invoice.metadata?.paymentReference || null,
    lineItems,
  };
}

export function isNextcloudConfigured(): boolean {
  return Boolean(
    process.env.NEXTCLOUD_BASE_URL &&
      process.env.NEXTCLOUD_USERNAME &&
      process.env.NEXTCLOUD_APP_PASSWORD &&
      process.env.NEXTCLOUD_REGISTER_ID &&
      process.env.NEXTCLOUD_CLIENT_SCHEMA_ID
  );
}

export function isNextcloudLedgerConfigured(): boolean {
  return Boolean(isNextcloudConfigured() && process.env.NEXTCLOUD_LEDGER_SCHEMA_ID);
}

function mapClientStatusToExternal(status: string): "lead" | "client" | "inactive" {
  if (status === "lead") return "lead";
  if (status === "inactive") return "inactive";
  return "client";
}

function buildCreateUrl(): string {
  const base = process.env.NEXTCLOUD_BASE_URL?.replace(/\/$/, "") ?? "";
  const registerId = process.env.NEXTCLOUD_REGISTER_ID ?? "";
  const schemaId = process.env.NEXTCLOUD_CLIENT_SCHEMA_ID ?? "";
  return `${base}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}`;
}

function buildUpdateUrl(externalId: string): string {
  const base = process.env.NEXTCLOUD_BASE_URL?.replace(/\/$/, "") ?? "";
  const registerId = process.env.NEXTCLOUD_REGISTER_ID ?? "";
  const schemaId = process.env.NEXTCLOUD_CLIENT_SCHEMA_ID ?? "";
  return `${base}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}/${encodeURIComponent(externalId)}`;
}

function buildLedgerCreateUrl(): string {
  const base = process.env.NEXTCLOUD_BASE_URL?.replace(/\/$/, "") ?? "";
  const registerId = process.env.NEXTCLOUD_REGISTER_ID ?? "";
  const schemaId = process.env.NEXTCLOUD_LEDGER_SCHEMA_ID ?? "";
  return `${base}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}`;
}

function buildLedgerUpdateUrl(externalId: string): string {
  const base = process.env.NEXTCLOUD_BASE_URL?.replace(/\/$/, "") ?? "";
  const registerId = process.env.NEXTCLOUD_REGISTER_ID ?? "";
  const schemaId = process.env.NEXTCLOUD_LEDGER_SCHEMA_ID ?? "";
  return `${base}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}/${encodeURIComponent(externalId)}`;
}

export function nextcloudAuthHeaders(): Record<string, string> {
  const user = process.env.NEXTCLOUD_USERNAME ?? "";
  const pass = process.env.NEXTCLOUD_APP_PASSWORD ?? "";
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return {
    authorization: `Basic ${token}`,
    "content-type": "application/json",
    accept: "application/json",
    "ocs-apirequest": "true",
  };
}

function normalizeSyncError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 1000);
  return String(err).slice(0, 1000);
}

async function saveSyncState(
  clientId: string,
  values: Partial<{
    syncStatus: SyncStatus;
    syncError: string | null;
    syncAttempts: number;
    lastSyncAttemptAt: Date | null;
    lastSyncedAt: Date | null;
    externalId: string | null;
  }>
): Promise<void> {
  const now = new Date();
  await db
    .insert(profileSyncState)
    .values({
      clientId,
      syncStatus: values.syncStatus ?? "pending",
      syncError: values.syncError ?? null,
      syncAttempts: values.syncAttempts ?? 0,
      lastSyncAttemptAt: values.lastSyncAttemptAt ?? null,
      lastSyncedAt: values.lastSyncedAt ?? null,
      externalId: values.externalId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: profileSyncState.clientId,
      set: {
        syncStatus: values.syncStatus,
        syncError: values.syncError,
        syncAttempts: values.syncAttempts,
        lastSyncAttemptAt: values.lastSyncAttemptAt,
        lastSyncedAt: values.lastSyncedAt,
        externalId: values.externalId,
        updatedAt: now,
      },
    });
}

export async function markClientSyncPending(clientId: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(profileSyncState)
    .where(eq(profileSyncState.clientId, clientId))
    .limit(1);
  await saveSyncState(clientId, {
    syncStatus: "pending",
    syncError: null,
    syncAttempts: (existing?.syncAttempts ?? 0) + 1,
    lastSyncAttemptAt: new Date(),
    externalId: existing?.externalId ?? null,
  });
}

async function saveInvoiceSyncState(
  stripeInvoiceId: string,
  clientId: string,
  values: Partial<{
    syncStatus: SyncStatus;
    syncError: string | null;
    syncAttempts: number;
    lastSyncAttemptAt: Date | null;
    lastSyncedAt: Date | null;
    externalId: string | null;
  }>
): Promise<void> {
  const now = new Date();
  await db
    .insert(invoiceSyncState)
    .values({
      stripeInvoiceId,
      clientId,
      syncStatus: values.syncStatus ?? "pending",
      syncError: values.syncError ?? null,
      syncAttempts: values.syncAttempts ?? 0,
      lastSyncAttemptAt: values.lastSyncAttemptAt ?? null,
      lastSyncedAt: values.lastSyncedAt ?? null,
      externalId: values.externalId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: invoiceSyncState.stripeInvoiceId,
      set: {
        clientId,
        syncStatus: values.syncStatus,
        syncError: values.syncError,
        syncAttempts: values.syncAttempts,
        lastSyncAttemptAt: values.lastSyncAttemptAt,
        lastSyncedAt: values.lastSyncedAt,
        externalId: values.externalId,
        updatedAt: now,
      },
    });
}

async function markInvoiceSyncPending(stripeInvoiceId: string, clientId: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(invoiceSyncState)
    .where(eq(invoiceSyncState.stripeInvoiceId, stripeInvoiceId))
    .limit(1);

  await saveInvoiceSyncState(stripeInvoiceId, clientId, {
    syncStatus: "pending",
    syncError: null,
    syncAttempts: (existing?.syncAttempts ?? 0) + 1,
    lastSyncAttemptAt: new Date(),
    lastSyncedAt: existing?.lastSyncedAt ?? null,
    externalId: existing?.externalId ?? null,
  });
}

async function pushProfileToNextcloud(
  payload: NextcloudProfilePayload
): Promise<{ externalId: string | null }> {
  if (!isNextcloudConfigured()) {
    throw new Error("Nextcloud credentials are not configured.");
  }

  const hasExternalId = Boolean(payload.externalId);
  const url = hasExternalId ? buildUpdateUrl(payload.externalId!) : buildCreateUrl();
  const method = hasExternalId ? "PUT" : "POST";
  const body = toOpenRegisterPayload(payload);

  const response = await fetch(url, {
    method,
    headers: nextcloudAuthHeaders(),
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Nextcloud sync failed (${response.status}): ${raw.slice(0, 1000)}`);
  }

  if (!raw) {
    return { externalId: payload.externalId ?? null };
  }

  try {
    const parsed = JSON.parse(raw) as { id?: string };
    const resolved = parsed.id ?? payload.externalId ?? null;
    return { externalId: resolved };
  } catch {
    return { externalId: payload.externalId ?? null };
  }
}

async function pushInvoiceToNextcloud(
  payload: NextcloudLedgerPayload
): Promise<{ externalId: string | null }> {
  if (!isNextcloudLedgerConfigured()) {
    throw new Error("Nextcloud ledger credentials are not configured.");
  }

  const hasExternalId = Boolean(payload.externalId);
  const url = hasExternalId ? buildLedgerUpdateUrl(payload.externalId!) : buildLedgerCreateUrl();
  const method = hasExternalId ? "PUT" : "POST";
  const body = toOpenRegisterLedgerPayload(payload);

  const response = await fetch(url, {
    method,
    headers: nextcloudAuthHeaders(),
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Nextcloud ledger sync failed (${response.status}): ${raw.slice(0, 1000)}`);
  }

  if (!raw) {
    return { externalId: payload.externalId ?? null };
  }

  try {
    const parsed = JSON.parse(raw) as { id?: string };
    return { externalId: parsed.id ?? payload.externalId ?? null };
  } catch {
    return { externalId: payload.externalId ?? null };
  }
}

export async function syncClientProfileToNextcloud(clientId: string): Promise<SyncStateRecord> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) {
    throw new Error("Client not found.");
  }

  if (!isCrmWorkspace(client.workspace)) {
    return {
      clientId,
      syncStatus: "synced",
      syncError: null,
      syncAttempts: 0,
      lastSyncAttemptAt: null,
      lastSyncedAt: null,
      externalId: null,
    };
  }

  await markClientSyncPending(clientId);

  const [pendingState] = await db
    .select()
    .from(profileSyncState)
    .where(eq(profileSyncState.clientId, clientId))
    .limit(1);

  const payload: NextcloudProfilePayload = {
    externalId: pendingState?.externalId ?? null,
    workspace: client.workspace,
    companyName: client.name,
    contactName: client.billingContactName ?? client.name,
    contactEmail: client.email,
    status: mapClientStatusToExternal(client.status),
    phone: client.phone ?? null,
    notes: client.notes ?? null,
  };

  try {
    const pushed = await pushProfileToNextcloud(payload);
    const now = new Date();
    await saveSyncState(clientId, {
      syncStatus: "synced",
      syncError: null,
      syncAttempts: pendingState?.syncAttempts ?? 1,
      lastSyncAttemptAt: pendingState?.lastSyncAttemptAt ?? now,
      lastSyncedAt: now,
      externalId: pushed.externalId ?? pendingState?.externalId ?? null,
    });
  } catch (error) {
    await saveSyncState(clientId, {
      syncStatus: "failed",
      syncError: normalizeSyncError(error),
      syncAttempts: pendingState?.syncAttempts ?? 1,
      lastSyncAttemptAt: pendingState?.lastSyncAttemptAt ?? new Date(),
      lastSyncedAt: pendingState?.lastSyncedAt ?? null,
      externalId: pendingState?.externalId ?? null,
    });
  }

  const [finalState] = await db
    .select()
    .from(profileSyncState)
    .where(eq(profileSyncState.clientId, clientId))
    .limit(1);

  return {
    clientId,
    syncStatus: (finalState?.syncStatus ?? "pending") as SyncStatus,
    syncError: finalState?.syncError ?? null,
    syncAttempts: finalState?.syncAttempts ?? 0,
    lastSyncAttemptAt: finalState?.lastSyncAttemptAt?.toISOString() ?? null,
    lastSyncedAt: finalState?.lastSyncedAt?.toISOString() ?? null,
    externalId: finalState?.externalId ?? null,
  };
}

export async function syncInvoiceToNextcloud(
  input: NextcloudLedgerInvoiceInput
): Promise<InvoiceSyncStateRecord> {
  if (!isCrmWorkspace(input.workspace)) {
    return {
      stripeInvoiceId: input.stripeInvoiceId,
      clientId: input.clientId,
      syncStatus: "synced",
      syncError: null,
      syncAttempts: 0,
      lastSyncAttemptAt: null,
      lastSyncedAt: null,
      externalId: null,
    };
  }

  await markInvoiceSyncPending(input.stripeInvoiceId, input.clientId);

  const [pendingState] = await db
    .select()
    .from(invoiceSyncState)
    .where(eq(invoiceSyncState.stripeInvoiceId, input.stripeInvoiceId))
    .limit(1);

  const payload: NextcloudLedgerPayload = {
    ...input,
    externalId: pendingState?.externalId ?? null,
  };

  try {
    const pushed = await pushInvoiceToNextcloud(payload);
    const now = new Date();
    await saveInvoiceSyncState(input.stripeInvoiceId, input.clientId, {
      syncStatus: "synced",
      syncError: null,
      syncAttempts: pendingState?.syncAttempts ?? 1,
      lastSyncAttemptAt: pendingState?.lastSyncAttemptAt ?? now,
      lastSyncedAt: now,
      externalId: pushed.externalId ?? pendingState?.externalId ?? null,
    });
  } catch (error) {
    await saveInvoiceSyncState(input.stripeInvoiceId, input.clientId, {
      syncStatus: "failed",
      syncError: normalizeSyncError(error),
      syncAttempts: pendingState?.syncAttempts ?? 1,
      lastSyncAttemptAt: pendingState?.lastSyncAttemptAt ?? new Date(),
      lastSyncedAt: pendingState?.lastSyncedAt ?? null,
      externalId: pendingState?.externalId ?? null,
    });
  }

  const [finalState] = await db
    .select()
    .from(invoiceSyncState)
    .where(eq(invoiceSyncState.stripeInvoiceId, input.stripeInvoiceId))
    .limit(1);

  return {
    stripeInvoiceId: input.stripeInvoiceId,
    clientId: finalState?.clientId ?? input.clientId,
    syncStatus: (finalState?.syncStatus ?? "pending") as SyncStatus,
    syncError: finalState?.syncError ?? null,
    syncAttempts: finalState?.syncAttempts ?? 0,
    lastSyncAttemptAt: finalState?.lastSyncAttemptAt?.toISOString() ?? null,
    lastSyncedAt: finalState?.lastSyncedAt?.toISOString() ?? null,
    externalId: finalState?.externalId ?? null,
  };
}

export async function getSyncStateMap(clientIds: string[]): Promise<Map<string, SyncStateRecord>> {
  if (clientIds.length === 0) return new Map();

  const states = await db
    .select()
    .from(profileSyncState)
    .where(inArray(profileSyncState.clientId, clientIds));

  return new Map(
    states.map((state) => [
      state.clientId,
      {
        clientId: state.clientId,
        syncStatus: state.syncStatus,
        syncError: state.syncError,
        syncAttempts: state.syncAttempts,
        lastSyncAttemptAt: state.lastSyncAttemptAt?.toISOString() ?? null,
        lastSyncedAt: state.lastSyncedAt?.toISOString() ?? null,
        externalId: state.externalId,
      },
    ])
  );
}

export async function getInvoiceSyncStateMap(
  stripeInvoiceIds: string[]
): Promise<Map<string, InvoiceSyncStateRecord>> {
  if (stripeInvoiceIds.length === 0) return new Map();

  const states = await db
    .select()
    .from(invoiceSyncState)
    .where(inArray(invoiceSyncState.stripeInvoiceId, stripeInvoiceIds));

  return new Map(
    states.map((state) => [
      state.stripeInvoiceId,
      {
        stripeInvoiceId: state.stripeInvoiceId,
        clientId: state.clientId,
        syncStatus: state.syncStatus,
        syncError: state.syncError,
        syncAttempts: state.syncAttempts,
        lastSyncAttemptAt: state.lastSyncAttemptAt?.toISOString() ?? null,
        lastSyncedAt: state.lastSyncedAt?.toISOString() ?? null,
        externalId: state.externalId,
      },
    ])
  );
}

export function isValidNextcloudWebhook(
  requestSecret: string | undefined,
  rawBody: string
): boolean {
  const expected = process.env.NEXTCLOUD_WEBHOOK_SECRET;
  if (!expected || !requestSecret) return false;
  const computed = crypto
    .createHash("sha256")
    .update(rawBody + expected)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(requestSecret), Buffer.from(computed));
  } catch {
    return false;
  }
}

export async function upsertClientFromNextcloudWebhook(payload: {
  workspace?: string;
  externalId?: string;
  companyName?: string;
  contactName?: string;
  contactEmail?: string;
  status?: "lead" | "client" | "inactive";
  phone?: string | null;
  notes?: string | null;
}): Promise<void> {
  const workspace = "dfwsc_services";
  const email = payload.contactEmail?.toLowerCase().trim();
  const name = payload.companyName?.trim();
  if (!email || !name) {
    throw new Error("Webhook payload requires companyName and contactEmail.");
  }

  const mappedStatus =
    payload.status === "lead" ? "lead" : payload.status === "inactive" ? "inactive" : "active";

  const [existingByExternal] = payload.externalId
    ? await db
        .select({ clientId: profileSyncState.clientId })
        .from(profileSyncState)
        .where(
          and(
            eq(profileSyncState.externalSource, "nextcloud"),
            eq(profileSyncState.externalId, payload.externalId)
          )
        )
        .limit(1)
    : [];

  const [existingClient] = existingByExternal
    ? await db.select().from(clients).where(eq(clients.id, existingByExternal.clientId)).limit(1)
    : await db
        .select()
        .from(clients)
        .where(and(eq(clients.email, email), eq(clients.workspace, workspace)))
        .limit(1);

  const now = new Date();

  if (existingClient) {
    await db
      .update(clients)
      .set({
        name,
        email,
        billingContactName: payload.contactName?.trim() ?? existingClient.billingContactName,
        phone: payload.phone ?? existingClient.phone,
        notes: payload.notes ?? existingClient.notes,
        status: mappedStatus,
        updatedAt: now,
      })
      .where(eq(clients.id, existingClient.id));

    await saveSyncState(existingClient.id, {
      syncStatus: "synced",
      syncError: null,
      syncAttempts: 0,
      lastSyncAttemptAt: now,
      lastSyncedAt: now,
      externalId: payload.externalId ?? null,
    });
    return;
  }

  const id = crypto.randomUUID();
  await db.insert(clients).values({
    id,
    workspace,
    name,
    email,
    billingContactName: payload.contactName?.trim() ?? name,
    phone: payload.phone ?? null,
    notes: payload.notes ?? null,
    status: mappedStatus,
    createdAt: now,
    updatedAt: now,
  });

  await saveSyncState(id, {
    syncStatus: "synced",
    syncError: null,
    syncAttempts: 0,
    lastSyncAttemptAt: now,
    lastSyncedAt: now,
    externalId: payload.externalId ?? null,
  });
}
