# CRM & Nextcloud Removal Plan

## What's being REMOVED
- All Nextcloud sync (outbound/inbound)
- Suspend/reinstate/sync-payment routes
- CRM lead pipeline concepts

## What's being KEPT
- Invoicing (invoices, subscriptions, payments, webhooks)
- `/dfwsc/clients` and `/dfwsc/leads/:id/convert` routes (stripped of Nextcloud sync)
- Client model (minus CRM-specific columns)

---

## Phase 1: Delete standalone files ✅ DONE
- [x] `backend/src/lib/nextcloud-sync.ts`
- [x] `backend/src/lib/nextcloud-poll.ts`
- [x] `backend/src/lib/payment-sync.ts`
- [x] `backend/src/routes/integrations.ts`

## Phase 2: Strip Nextcloud sync calls and CRM routes from route files

### `backend/src/routes/dfwsc-clients.ts`

**Remove imports:**
- `import { getSyncStateMap, syncClientProfileToNextcloud } from "../lib/nextcloud-sync";`
- `import { isCrmWorkspace, type Workspace } from "../lib/workspace";`
- Add: `import { type Workspace } from "../lib/workspace";`

**Remove the entire `/crm/leads` route** (lines 281-333)

**Remove the entire `/crm/leads/:id/convert` route** (lines 389-437)

**In `createDirectBillableClient` POST `/dfwsc/clients` handler:**
- Remove the call to `syncClientProfileToNextcloud(createdClient.id).catch(...)` (lines 241-243)
- Remove `const syncStateMap = await getSyncStateMap(...)` and `const syncState = syncStateMap.get(...)` (lines 244-245)
- Remove sync state fields from the response: `syncStatus`, `syncError`, `syncAttempts`, `lastSyncAttemptAt`, `lastSyncedAt` (lines 264-268)

**In `/dfwsc/leads` POST handler:**
- Remove `syncClientProfileToNextcloud(lead.id).catch(...)` (lines 359-361)
- Remove `getSyncStateMap` and `syncState` usage (lines 362-363)
- Remove sync state fields from response (lines 374-380)

**In `/dfwsc/leads/:id/convert` POST handler:**
- Remove `syncClientProfileToNextcloud(updated.id).catch(...)` (lines 453-455)
- Remove `getSyncStateMap` and `syncState` usage (lines 456-457)
- Remove sync state fields from response (lines 464-472)
- Remove `suspendedAt: null` and `paymentStatusSyncedAt: null` from response

**In `LeadBody` interface:**
- Remove `lastContactAt`, `nextAction`, `followUpAt` fields (lines 34-36) — these are CRM tracking fields

**In `createLead` function:**
- Remove `lastContactAt`, `nextAction`, `followUpAt` from the insert values (lines 154-156)

**In `convertLead` function response:**
- Remove `lastContactAt`, `followUpAt`, `suspendedAt`, `paymentStatusSyncedAt` from response

### `backend/src/routes/clients.ts`

**Remove imports:**
- `import { getSyncStateMap, syncClientProfileToNextcloud } from "../lib/nextcloud-sync";`
- `import { CRM_WORKSPACES, isWorkspace } from "../lib/workspace";` → change to `import { isWorkspace } from "../lib/workspace";`

**In `ClientPatchBody` interface:**
- Remove `lastContactAt`, `nextAction`, `followUpAt` fields (lines 28-30)
- Remove `billingContactName` (line 19) — actually keep this one, it's used for invoicing

**In GET `/clients` handler:**
- Remove `paymentStatus`, `paymentStatusSyncedAt`, `lastContactAt`, `nextAction`, `followUpAt`, `suspendedAt`, `suspensionReason` from the select (lines 73-78, 79)
- Remove `getSyncStateMap` call and all sync state fields from response (lines 102, 112-116)
- Remove date formatting for `paymentStatusSyncedAt`, `lastContactAt`, `followUpAt`, `suspendedAt` from response

**In GET `/clients/:id` handler:**
- Remove `getSyncStateMap` call and sync state fields (lines 152-153, 161-165)
- Remove `lastContactAt`, `followUpAt` date formatting from response (lines 159-160)

**In PATCH `/clients/:id` handler:**
- Remove `lastContactAt`, `nextAction`, `followUpAt` from `setValues` (lines 351-355)
- Remove validation for `lastContactAt` and `followUpAt` (lines 198-204)
- Remove `syncClientProfileToNextcloud` call (lines 401-403)
- Remove `getSyncStateMap` call and sync state fields (lines 404-405, 414-418)
- Remove `lastContactAt`, `followUpAt` date formatting from response (lines 412-413)

**Remove entire POST `/clients/sync-payment-status` route** (lines 425-436)

**Remove entire POST `/clients/:id/suspend` route** (lines 438-490)

**Remove entire POST `/clients/:id/reinstate` route** (lines 492-543)

**Remove entire POST `/clients/:id/retry-sync` route** (lines 545-561)

### `backend/src/routes/connect.ts`

**Remove import:**
- `import { getSyncStateMap, syncClientProfileToNextcloud } from "../lib/nextcloud-sync";`

**In POST `/accounts` handler (dfwsc_services branch, around line 212):**
- Remove `syncClientProfileToNextcloud(createdClient.id).catch(...)` (lines 212-214)
- Remove `getSyncStateMap` and sync state retrieval (lines 215-216)
- Remove sync state fields from response (lines 226-230)

### `backend/src/routes/invoices.ts`

**Remove import:**
- `import { syncInvoiceToNextcloud, toNextcloudLedgerInvoiceInput } from "../lib/nextcloud-sync";`

**In POST `/invoices` handler:**
- Remove the entire try/catch block for Nextcloud ledger sync (lines 201-223)

**In PATCH `/invoices/:id` handler:**
- Remove the entire try/catch block for Nextcloud ledger sync after void (lines 305-329)

**In POST `/invoices/:id/mark-paid-out-of-band` handler:**
- Remove the entire try/catch block for Nextcloud ledger sync (lines 394-418)

### `backend/src/routes/webhooks.ts`

**Remove imports:**
- `import { syncInvoiceToNextcloud, toNextcloudLedgerInvoiceInput } from "../lib/nextcloud-sync";`

**Remove the `syncInvoiceToNextcloudLedger` helper function** (lines 55-82)

**Remove calls to `syncInvoiceToNextcloudLedger` in:**
- `invoice.payment_succeeded` handler (line 181)
- `invoice.payment_failed` handler (line 194)
- `invoice.paid` handler (line 267)

**Also remove `setClientPaymentStatusByCustomer` function** (lines 25-31) and all calls to it, since `paymentStatus`/`paymentStatusSyncedAt` columns are being removed. This means removing:
- Line 179: `await setClientPaymentStatusByCustomer(customerId, "active");`
- Line 191: `await setClientPaymentStatusByCustomer(customerId, "past_due");`
- Lines 205-216: the entire payment status mapping block in `customer.subscription.updated`
- Line 229: `await setClientPaymentStatusByCustomer(customerId, "past_due");`
- Line 241: `await setClientPaymentStatusByCustomer(customerId, "active");`
- Line 253: `await setClientPaymentStatusByCustomer(customerId, "canceled");`
- Line 265: `await setClientPaymentStatusByCustomer(customerId, "active");`

Also remove the `PaymentStatus` type alias (line 14) and the `resolveInvoiceClient` function (lines 33-53) **only if not used elsewhere** — actually it IS used by the sync helper we're removing, but NOT used elsewhere in webhooks.ts after removing the sync. So remove it.

Also remove the `clients` import (line 6) if `setClientPaymentStatusByCustomer` was the only usage — check: `clients` is also used for setting `paymentStatus` via `db.update(clients)`. After removing all payment status updates, check if `clients` is still used. The `clients` import is no longer needed if all we're doing is removing that function. But verify: are there other uses of `clients` in webhooks.ts? No — the only db operations are the payment status updates and those are being removed. The webhook events handler also updates `webhookEvents`. So we might need to keep `clients` import if `account.updated` still imports it. Wait, let me check — `account.updated` does `db.update(clients)` on line 143. So we need to keep `clients` import.

### `backend/src/routes/subscriptions.ts`

**Remove import:**
- `import { syncInvoiceToNextcloud, toNextcloudLedgerInvoiceInput } from "../lib/nextcloud-sync";`

**In POST `/subscriptions` handler:**
- Remove the entire try/catch block for Nextcloud ledger sync for first invoice (lines 597-623)

### `backend/src/routes/payments.ts`

**Remove the CRM comment** on line 333:
- Change `// For CRM billing workspaces, allow fetching all payments across all clients in the workspace` to just `// Allow fetching all payments across all clients in the workspace`

The actual logic is fine since it checks for `workspace === "dfwsc_services"` which is still valid.

### `backend/src/server.ts`

**Remove import:**
- `import { startNextcloudPolling } from "./lib/nextcloud-poll";`

**Remove call:**
- `startNextcloudPolling();` (line 12)

### `backend/src/index.ts`

**Remove lines 24-25:**
- `const { startPaymentSyncJob } = await import("./lib/payment-sync");`
- `startPaymentSyncJob();`

### `backend/src/app.ts`

**Remove import:**
- `import integrationRoutes from "./routes/integrations";`

**Remove route registration:**
- `server.register(integrationRoutes, { prefix: "/api/v1" });` (line 144)

## Phase 3: Clean up schema.ts, workspace.ts, env.ts

### `backend/src/db/schema.ts`

**Remove entire `profileSyncState` table** (lines 103-118)

**Remove entire `invoiceSyncState` table** (lines 120-145)

**Remove from `clients` table:**
- `paymentStatus` column (lines 64-66)
- `paymentStatusSyncedAt` column (line 67)
- `suspendedAt` column (line 68)
- `suspensionReason` column (line 69)
- `lastContactAt` column (line 60)
- `nextAction` column (line 61)
- `followUpAt` column (line 62)
- `billingContactName` column (line 52) — wait, this is used for invoicing. KEEP it.

**Remove `"lead"` from `status` enum** on clients → change to `["active", "inactive"]`

**Remove `"ledger_crm"` from `workspace` enum** on both `clients` and `clientGroups` → change to `["dfwsc_services", "client_portal"]`

### `backend/src/lib/workspace.ts`

**Remove:**
- `CRM_WORKSPACES` export (line 3)
- `isCrmWorkspace` function (lines 11-14)

### `backend/src/lib/env.ts`

**Remove from `OPTIONAL_ENV_VARS` array:**
- `"NEXTCLOUD_BASE_URL"`
- `"NEXTCLOUD_USERNAME"`
- `"NEXTCLOUD_APP_PASSWORD"`
- `"NEXTCLOUD_WEBHOOK_SECRET"`
- `"NEXTCLOUD_REGISTER_ID"`
- `"NEXTCLOUD_CLIENT_SCHEMA_ID"`
- `"NEXTCLOUD_LEAD_SCHEMA_ID"`
- `"NEXTCLOUD_LEDGER_SCHEMA_ID"`
- `"NEXTCLOUD_SYNC_MODE"`
- `"NEXTCLOUD_POLL_INTERVAL_MS"`

## Phase 4: Frontend cleanup

### Delete files:
- `front/src/api/crm.js`
- `front/src/hooks/useCRM.js`
- `front/src/__tests__/crmApi.test.js`

### `front/src/components/admin/ClientProfile.jsx`

**Remove import:**
- `import { useConvertToClient, useSuspendClient, useReinstateClient } from "../../hooks/useCRM";`

**Remove mutation hooks:**
- `const suspendMutation = useSuspendClient(workspace);` (line 54)
- `const reinstateMutation = useReinstateClient(workspace);` (line 55)
- `const convertMutation = useConvertToClient(workspace);` (line 56)

**Remove helper functions:**
- `resolvePaymentHealth` function (lines 23-28) — references `paymentStatus` and `suspendedAt`
- `canSuspend` function (lines 30-32)
- `handleSuspend` function (lines 81-96)
- `handleReinstate` function (lines 99-110)
- `handleConvertLead` function (lines 113-125)

**Remove from JSX:**
- Payment Health badge section (lines 146-148)
- Lead conversion section (lines 161-167 and lines 185-188)
- Suspend/Reinstate buttons (lines 197-215)
- Suspended info box (lines 221-230)
- All references to `isLead`, `isSuspended`, `paymentHealth`, `canSuspend`

**Remove state/variables:**
- `const paymentHealth = ...` (line 60)
- `const isSuspended = ...` (line 61)
- `const isLead = ...` (line 62)

### `front/src/components/admin/AddClientModal.jsx`

**Remove import:**
- `import { useCreateLead } from "../../hooks/useCRM";`

**Remove:**
- `const createLeadMutation = useCreateLead("dfwsc_services");` (line 10)
- The "Create As" dropdown (recordType select) and its state
- The lead/client toggle logic
- Simplify to just create client (no lead option)

### `front/src/pages/Pricing.jsx`

**Change line 113** from:
- `"Integrations with Stripe, CRMs, and analytics platforms baked in."`
to:
- `"Integrations with Stripe and analytics platforms baked in."`

## Phase 5: Database migration

Generate a Drizzle migration that:
1. Drops `profile_sync_state` table
2. Drops `invoice_sync_state` table
3. Drops columns from `clients`: `payment_status`, `payment_status_synced_at`, `suspended_at`, `suspension_reason`, `last_contact_at`, `next_action`, `follow_up_at`
4. Does NOT drop `billing_contact_name` (keep it for invoicing)
5. Updates `status` enum to remove `"lead"`
6. Updates `workspace` enum to remove `"ledger_crm"`

Run: `npm run db:generate` after schema changes, then `npm run db:migrate`

## Phase 6: Config & docs cleanup

### `.env`
- Remove lines 39-41: `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, `NEXTCLOUD_APP_PASSWORD`
- Remove any other NEXTCLOUD_* vars

### `.env.example`
- Remove lines 71-79: all `NEXTCLOUD_*` entries

### Delete docs:
- `docs/NEXTCLOUD.md`
- `docs/CRM.md`

### Update docs:
- `docs/ARCHITECTURE.md` — remove references to CRM.md, NEXTCLOUD.md, profile_sync_state, CRM columns
- `docs/BACKEND.md` — remove CRM workspace, lead pipeline routes, Nextcloud sync section, webhook route table entry
- `docs/DATABASE.md` — remove profile_sync_state table docs, CRM/payment sync columns
- `AGENTS.md` — remove NEXTCLOUD.md link
- `README.md` — remove CRM routes from API table

## Phase 7: Tests

### `backend/src/__tests__/app.test.ts`

**Remove the entire `"workspace CRM"` describe block** (lines 1181-1241)

**Remove any other references to:**
- `setClientPaymentStatusByClient` / payment status assertions
- Nextcloud sync mocks
- CRM workspace-specific assertions
- `"lead"` status assertions

**In mock setup:**
- Remove any `nextcloud-sync` or `nextcloud-poll` or `payment-sync` mock entries
- Remove `profileSyncState` / `invoiceSyncState` mock data
- Remove `NEXTCLOUD_*` env vars from test setup

Run `make test` to verify.

## Phase 8: Final cleanup

- Run `make test` to verify all tests pass
- Check for any remaining `import` references to deleted files
- Search for `nextcloud`, `CRM`, `crm` in codebase to catch stragglers