import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { clients, profileSyncState } from "../db/schema";
import { isNextcloudConfigured, nextcloudAuthHeaders } from "./nextcloud-sync";
import { isCrmWorkspace } from "./workspace";

/**
 * Nextcloud OpenRegister Polling Scheduler
 *
 * Polls OpenRegister for inbound client changes every NEXTCLOUD_POLL_INTERVAL_MS.
 * Uses individual GET /objects/{reg}/{schema}/{id} per known external object,
 * since the GET list endpoint returns 500 (OpenRegister bug).
 *
 * For new objects created on the Nextcloud side, the webhook handler is the
 * primary ingestion path. Polling catches updates to existing synced objects.
 */

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startNextcloudPolling(): void {
  if (!isNextcloudConfigured()) return;
  if (process.env.NEXTCLOUD_SYNC_MODE === "disabled") return;

  const interval = Number(process.env.NEXTCLOUD_POLL_INTERVAL_MS ?? 60000);
  pollTimer = setInterval(() => {
    pollNextcloudChanges().catch((err) => {
      console.error("Nextcloud poll failed:", err);
    });
  }, interval);
}

export function stopNextcloudPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export async function pollNextcloudChanges(): Promise<number> {
  if (!isNextcloudConfigured()) return 0;
  if (process.env.NEXTCLOUD_SYNC_MODE === "disabled") return 0;

  const syncedRows = await db
    .select({
      clientId: profileSyncState.clientId,
      externalId: profileSyncState.externalId,
    })
    .from(profileSyncState)
    .where(eq(profileSyncState.syncStatus, "synced"));

  if (syncedRows.length === 0) return 0;

  const base = process.env.NEXTCLOUD_BASE_URL!.replace(/\/$/, "");
  const registerId = process.env.NEXTCLOUD_REGISTER_ID!;
  const schemaId = process.env.NEXTCLOUD_CLIENT_SCHEMA_ID!;

  let processed = 0;

  for (const row of syncedRows) {
    if (!row.externalId) continue;

    const url = `${base}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}/${encodeURIComponent(row.externalId)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: nextcloudAuthHeaders(),
      });
    } catch {
      continue;
    }

    if (!response.ok) continue;

    const raw = await response.text();
    if (!raw) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const name = typeof record.name === "string" ? record.name : null;
    const email = typeof record.email === "string" ? record.email.toLowerCase().trim() : null;
    const workspace =
      record._dfwsc_workspace === "dfwsc_services" ? "dfwsc_services" : "ledger_crm";
    const contactName =
      typeof record._dfwsc_contact_name === "string" ? record._dfwsc_contact_name : null;
    const phone = typeof record.phone === "string" ? record.phone : null;
    const notes = typeof record.notes === "string" ? record.notes : null;
    const statusRaw = typeof record.status === "string" ? record.status : "client";
    const mappedStatus =
      statusRaw === "lead" ? "lead" : statusRaw === "inactive" ? "inactive" : "active";

    if (!name || !email) continue;

    const [existingClient] = await db
      .select()
      .from(clients)
      .where(eq(clients.id, row.clientId))
      .limit(1);

    if (!existingClient) continue;
    if (!isCrmWorkspace(existingClient.workspace)) continue;

    const now = new Date();
    await db
      .update(clients)
      .set({
        name,
        email,
        billingContactName: contactName ?? existingClient.billingContactName,
        phone: phone ?? existingClient.phone,
        notes: notes ?? existingClient.notes,
        status: mappedStatus,
        updatedAt: now,
      })
      .where(eq(clients.id, existingClient.id));

    await db
      .insert(profileSyncState)
      .values({
        clientId: existingClient.id,
        syncStatus: "synced",
        syncError: null,
        syncAttempts: 0,
        lastSyncAttemptAt: now,
        lastSyncedAt: now,
        externalId: row.externalId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: profileSyncState.clientId,
        set: {
          syncStatus: "synced",
          syncError: null,
          syncAttempts: 0,
          lastSyncAttemptAt: now,
          lastSyncedAt: now,
          externalId: row.externalId,
          updatedAt: now,
        },
      });

    processed++;
  }

  return processed;
}
