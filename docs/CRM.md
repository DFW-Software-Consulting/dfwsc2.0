# CRM — Leads, Clients & Payment Tracking

The CRM tab is available in the **DFWSC Services** workspace of the admin dashboard. It manages the full lifecycle of a consulting engagement: from first contact (lead) through active billing (client) to suspension if payment lapses.

---

## Concepts

### Lead
A potential client. Stored in the `clients` table with `status = "lead"`. No Stripe customer is created yet — just contact info. Leads have a UUID primary key generated at creation time.

### Client
An active (or suspended) paying client. Has a `stripeCustomerId` set. Created either by:
1. Promoting a lead via **Convert to Client**, or
2. Creating directly via the **Accounts** tab (creates Stripe customer immediately)

### Payment Status
Cached from Stripe and stored on the `clients` row. Updated by the background sync job every 15 minutes. Possible values:

| Value | Meaning |
|---|---|
| `active` | Has an active subscription |
| `trialing` | In a trial period |
| `past_due` | Payment failed, retrying |
| `unpaid` | Payment failed, no more retries |
| `canceled` | All subscriptions canceled |
| `none` | No subscriptions at all |

---

## Lead Pipeline

### Adding a Lead
In the CRM tab, click **+ Add Lead**. Only name and email are required — phone and notes are optional. No Stripe call is made.

**Backend:** `POST /api/v1/dfwsc/leads`

```json
{
  "name": "Jane Smith",
  "email": "jane@company.com",
  "phone": "+1 (555) 123-4567",
  "notes": "Met at DFW Tech meetup, interested in web app"
}
```

Response: `201` with the created lead record.

### Converting a Lead to a Client
Click **Convert to Client** on any lead row. This:
1. Creates a Stripe customer using the lead's stored contact info
2. Sets `stripeCustomerId` on the DB record
3. Changes `status` from `"lead"` to `"active"`

If the Stripe customer creation succeeds but the DB update fails, the Stripe customer is automatically deleted (rollback).

**Backend:** `POST /api/v1/dfwsc/leads/:id/convert`

---

## Client Lifecycle

### Suspending a Client
Click **Suspend** on any active client row. A modal prompts for an optional reason. This sets:
- `status = "inactive"`
- `suspendedAt = now()`
- `suspensionReason = <your text>`

The suspension reason appears as a note beneath the Reinstate button so you can see why a client was suspended at a glance.

**Backend:** `POST /api/v1/clients/:id/suspend`

```json
{ "reason": "Overdue invoice — 45 days past due" }
```

### Reinstating a Client
Click **Reinstate** on any suspended row. Clears `suspendedAt` and `suspensionReason`, sets `status = "active"`.

**Backend:** `POST /api/v1/clients/:id/reinstate`

---

## Payment Sync

### Background Job
On server startup, and then every **15 minutes**, a background job:
1. Queries all `dfwsc_services` clients that have a `stripeCustomerId`
2. Fetches all Stripe subscriptions in a single paginated pass
3. Derives the effective payment status per client using priority order: `active > trialing > past_due > unpaid > canceled > none`
4. Updates `paymentStatus` and `paymentStatusSyncedAt` on each client row

The job uses `setInterval(...).unref()` — it won't prevent the process from exiting.

**File:** `backend/src/lib/payment-sync.ts`

### Manual Sync
In the CRM panel, click **Sync Now** to trigger an immediate sync. The button shows a loading state while the sync runs and toasts with the count of clients synced.

**Backend:** `POST /api/v1/clients/sync-payment-status`

Response: `{ "synced": 12 }`

---

## CRM Panel UI

The panel has three filter tabs:

| Tab | Shows |
|---|---|
| All | Every lead and client |
| Leads | Only `status = "lead"` rows |
| Clients | Everything that is not a lead |

**Columns:**

| Column | Leads | Clients |
|---|---|---|
| Name | ✓ | ✓ |
| Email | ✓ | ✓ |
| Status badge | Purple "Lead" | Green/Red/etc. |
| Payment Status | — | Stripe status badge |
| Last Synced | — | Timestamp of last sync |
| Actions | Convert to Client | Suspend / Reinstate |

---

## Database Columns (clients table)

These columns were added in migration `0007_gorgeous_fallen_one.sql`:

| Column | Type | Purpose |
|---|---|---|
| `payment_status` | `text` (default `"none"`) | Cached Stripe subscription status |
| `payment_status_synced_at` | `timestamptz` | When the status was last synced |
| `suspended_at` | `timestamptz` | When the client was suspended (null if active) |
| `suspension_reason` | `text` | Why they were suspended |

The `status` enum was extended to include `"lead"` (in addition to `"active"` and `"inactive"`).

---

## Files

| File | Purpose |
|---|---|
| `backend/src/lib/payment-sync.ts` | Background sync job |
| `backend/src/routes/clients.ts` | suspend, reinstate, sync-payment-status endpoints |
| `backend/src/routes/dfwsc-clients.ts` | POST /dfwsc/leads, POST /dfwsc/leads/:id/convert |
| `front/src/components/admin/CRMPanel.jsx` | Main CRM UI |
| `front/src/components/admin/SuspendModal.jsx` | Suspend reason modal |
| `front/src/hooks/useCRM.js` | TanStack Query mutations |
| `front/src/api/crm.js` | API call wrappers |
