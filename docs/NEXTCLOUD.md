# Nextcloud OpenRegister Integration — Bi-Directional Client Profile Sync

The DFWSC portal syncs client profiles bi-directionally with a Nextcloud instance running the **OpenRegister** app. This allows leads and clients to be created or updated from either system.

---

## Architecture Overview

```
DFWSC Portal  ←——→  Nextcloud OpenRegister
     │                      │
     │  Outbound sync       │  Inbound sync
     │  (POST / PUT)        │  (Webhook + Polling)
     │                      │
     └── profile_sync_state ┘  (tracks externalId + sync status)
```

Three mechanisms keep data in sync:

| Direction | Mechanism | Trigger |
|-----------|-----------|---------|
| **Outbound** (DFWSC → Nextcloud) | Push to OpenRegister API | On client create/update |
| **Inbound** (Nextcloud → DFWSC) | Webhook handler | Nextcloud `webhooks_listeners` event |
| **Inbound** (Nextcloud → DFWSC) | Polling scheduler | Every `NEXTCLOUD_POLL_INTERVAL_MS` (default 60s) |

---

## OpenRegister API

**Base URL:** `{NEXTCLOUD_BASE_URL}/index.php/apps/openregister/api/objects/{registerId}/{schemaId}`

**Auth:** HTTP Basic with `NEXTCLOUD_USERNAME` + `NEXTCLOUD_APP_PASSWORD` (app token). Sent with `OCS-APIREQUEST: true` header.

### Endpoints (verified as of 2026-04-25)

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| `POST` | `/{reg}/{schema}` | **201** | Create new object. Returns `id` field. |
| `PUT` | `/{reg}/{schema}/{id}` | **200** | Full update of existing object. |
| `PATCH` | `/{reg}/{schema}/{id}` | **200** | Partial update of existing object. |
| `GET` | `/{reg}/{schema}/{id}` | **200** | Fetch single object by ID. |
| `DELETE` | `/{reg}/{schema}/{id}` | **204** | Delete object. |
| `GET` | `/{reg}/{schema}` | **500** | **Broken** — OpenRegister returns Internal Server Error on list endpoint. Workaround: use individual GET per ID. |

### Object Shape (Outbound Payload)

When pushing a client to OpenRegister, the payload maps as follows:

| DFWSC Field | OpenRegister Field | Notes |
|-------------|-------------------|-------|
| `name` | `name` | Company name |
| — | `type` | Always `"organization"` |
| `email` | `email` | Contact email |
| `phone` | `phone` | Phone number |
| `notes` | `notes` | Admin notes |
| `status` | `status` | `"lead"`, `"client"`, or `"inactive"` |
| `clients.id` | `_dfwsc_client_id` | DFWSC internal UUID |
| `workspace` | `_dfwsc_workspace` | `"dfwsc_services"` or `"ledger_crm"` |
| `billingContactName` | `_dfwsc_contact_name` | Contact person name |

### Object Shape (Inbound from Polling/Webhook)

Fields read from OpenRegister objects:

| OpenRegister Field | DFWSC Field | Notes |
|-------------------|-------------|-------|
| `id` | `profile_sync_state.external_id` | OpenRegister object UUID |
| `name` | `clients.name` | Company name |
| `email` | `clients.email` | Lowercased and trimmed |
| `phone` | `clients.phone` | Phone number |
| `notes` | `clients.notes` | Notes |
| `status` | `clients.status` | Mapped: `"lead"` → `lead`, `"inactive"` → `inactive`, else → `active` |
| `_dfwsc_workspace` | `clients.workspace` | Falls back to `"ledger_crm"` if absent/unknown |
| `_dfwsc_contact_name` | `clients.billing_contact_name` | Contact name |
| `_dfwsc_client_id` | Used for lookup | Cross-reference to find existing DFWSC client |

---

## Environment Variables

All Nextcloud env vars are **optional**. If any required combination is missing, the integration is silently disabled.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXTCLOUD_ENABLED` | No | — | Set to `true` to enable (optional; auto-detected) |
| `NEXTCLOUD_BASE_URL` | Yes* | — | e.g. `https://cloud.dfwsc.com` |
| `NEXTCLOUD_USERNAME` | Yes* | — | Nextcloud admin username |
| `NEXTCLOUD_APP_PASSWORD` | Yes* | — | App-specific password (NOT the account password) |
| `NEXTCLOUD_WEBHOOK_SECRET` | Yes* | — | Shared secret for webhook SHA256 verification |
| `NEXTCLOUD_REGISTER_ID` | Yes* | — | OpenRegister register ID (e.g. `1`) |
| `NEXTCLOUD_CLIENT_SCHEMA_ID` | Yes* | — | OpenRegister client schema ID (e.g. `1`) |
| `NEXTCLOUD_SYNC_MODE` | No | `direct` | Set to `disabled` to disable polling and outbound sync |
| `NEXTCLOUD_POLL_INTERVAL_MS` | No | `60000` | Polling interval in milliseconds |

\* All five must be set together for the integration to activate. Checked by `isNextcloudConfigured()`.

Register and schema IDs can be retrieved from:
```bash
curl "https://cloud.dfwsc.com/index.php/apps/pipelinq/api/settings" \
  -u dfwsc-admin:<app-password> -H "OCS-APIREQUEST: true"
```

---

## Outbound Sync (DFWSC → Nextcloud)

### How It Works

1. When a CRM client is created or updated, `syncClientProfileToNextcloud(clientId)` is called.
2. If the client's workspace is not a CRM workspace (`dfwsc_services` or `ledger_crm`), the sync is skipped (returns `synced` status).
3. The sync state is marked `pending`, then the profile is pushed to OpenRegister.
4. **First sync** (no `externalId`): Sends `POST` to create a new object. Stores the returned `id` as `externalId`.
5. **Subsequent syncs** (has `externalId`): Sends `PUT` to update the existing object.
6. On success, the state is set to `synced` with `lastSyncedAt` timestamp.
7. On failure, the state is set to `failed` with `syncError` recorded.

### File

`backend/src/lib/nextcloud-sync.ts` — `pushProfileToNextcloud()`, `syncClientProfileToNextcloud()`

---

## Inbound Sync (Nextcloud → DFWSC)

### Webhook Handler

**Endpoint:** `POST /api/v1/integrations/nextcloud/webhook`

Receives push events from Nextcloud's `webhooks_listeners` app. Uses:

- **Signature verification**: `X-Nextcloud-Webhooks` header contains `SHA256(rawBody + NEXTCLOUD_WEBHOOK_SECRET)`, verified with `crypto.timingSafeEqual`.
- **Raw body**: Fastify's `rawBody` option ensures the raw request body is available for signature verification.
- **Upsert logic**: Looks up existing client by `externalId` (via `profile_sync_state`) or by `email + workspace`. Creates or updates accordingly.

### File

`backend/src/routes/integrations.ts` — webhook route
`backend/src/lib/nextcloud-sync.ts` — `upsertClientFromNextcloudWebhook()`, `isValidNextcloudWebhook()`

### Polling Scheduler

Runs on a configurable interval (`NEXTCLOUD_POLL_INTERVAL_MS`, default 60 seconds). Started on server boot via `startNextcloudPolling()` in `server.ts`.

**Since the OpenRegister GET list endpoint is broken (returns 500)**, polling does **not** list all objects. Instead:

1. Queries `profile_sync_state` for all rows with `syncStatus = "synced"` that have an `externalId`.
2. For each, fetches the individual object via `GET /objects/{reg}/{schema}/{externalId}`.
3. Updates the DFWSC client record with any changes from OpenRegister.
4. Silently skips objects that return errors (the next cycle will retry).

**For new objects created on the Nextcloud side**, the webhook handler is the primary ingestion path. Polling only catches updates to already-synced objects.

### File

`backend/src/lib/nextcloud-poll.ts` — `startNextcloudPolling()`, `stopNextcloudPolling()`, `pollNextcloudChanges()`

---

## Database Schema

### `profile_sync_state` Table

Tracks the sync state between DFWSC clients and their OpenRegister counterparts.

| Column | Type | Description |
|--------|------|-------------|
| `client_id` | `text` (PK, FK → `clients.id`) | Local client reference |
| `external_source` | `text` (default `"nextcloud"`) | Source system identifier |
| `external_id` | `text` | OpenRegister object UUID |
| `sync_status` | `text` | `"synced"`, `"pending"`, or `"failed"` |
| `sync_error` | `text` | Error message on failure (truncated to 1000 chars) |
| `sync_attempts` | `integer` | Number of sync attempts |
| `last_sync_attempt_at` | `timestamptz` | Most recent attempt timestamp |
| `last_synced_at` | `timestamptz` | Most recent successful sync timestamp |
| `created_at` | `timestamptz` | Row creation time |
| `updated_at` | `timestamptz` | Row update time |

---

## Sync Status Flow

```
  ┌──────────┐  push/webhook success  ┌──────────┐
  │ pending  │ ──────────────────────→ │  synced  │
  └──────────┘                         └──────────┘
       │                                     │
       │ push/webhook fail                   │ client updated
       ▼                                     ▼
  ┌──────────┐                         ┌──────────┐
  │  failed  │                         │ pending  │
  └──────────┘                         └──────────┘
       │                                     │
       │ retry                               │ push/webhook
       └─────────────────────────────────────┘
```

---

## Known Issues

### OpenRegister GET List Endpoint (500 Error)

- `GET /objects/{reg}/{schema}` returns `500 Internal Server Error`.
- This is a bug in the OpenRegister Nextcloud app, not in the DFWSC integration.
- **Workaround**: Polling uses individual `GET /objects/{reg}/{schema}/{id}` per known external object.
- New objects from Nextcloud are ingested via the webhook handler instead of polling.

---

## Files

| File | Purpose |
|------|---------|
| `backend/src/lib/nextcloud-sync.ts` | Core sync logic: `syncClientProfileToNextcloud()`, `upsertClientFromNextcloudWebhook()`, `isValidNextcloudWebhook()`, `getSyncStateMap()` |
| `backend/src/lib/nextcloud-poll.ts` | Polling scheduler: `startNextcloudPolling()`, `stopNextcloudPolling()`, `pollNextcloudChanges()` |
| `backend/src/routes/integrations.ts` | Webhook route: `POST /api/v1/integrations/nextcloud/webhook` |
| `backend/src/db/schema.ts` | `profileSyncState` table definition |
| `backend/src/lib/env.ts` | Optional environment variable registration |
| `backend/src/server.ts` | Calls `startNextcloudPolling()` on startup |
| `backend/.env` | Nextcloud configuration values |