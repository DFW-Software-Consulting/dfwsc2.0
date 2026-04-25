# Nextcloud Ledger Integration

The portal automatically syncs invoice activity to a CSV spreadsheet hosted on the DFWSC Nextcloud instance. This gives you a plain, always-up-to-date view of all billing without needing to log into Stripe.

---

## Where the Ledger Lives

**Nextcloud URL:** `https://cloud.dfwsc.com`  
**File path:** `/clients/dfwsc-ledger.csv`  
**Open in:** Nextcloud Files → `clients/` → `dfwsc-ledger.csv`

The file opens directly in Nextcloud's built-in spreadsheet viewer (or download it for Excel/LibreOffice).

---

## Spreadsheet Columns

| Column | Description |
|---|---|
| Date | Date the invoice was created (YYYY-MM-DD) |
| Client | Client name |
| Invoice ID | Stripe invoice ID (`in_xxx`) |
| Description | Invoice line item description |
| Amount (USD) | Base amount billed (before fee) |
| Fee (USD) | Processing fee charged |
| Total (USD) | Total amount due (amount + fee) |
| Status | Current status: `open`, `paid`, `void`, `uncollectible` |
| Due Date | Payment due date |
| Paid At | Date payment was received (filled in automatically) |

---

## How It Stays Updated

### New Invoice Created
When you create a new invoice in the portal, a row is appended to the CSV immediately (fire-and-forget — the HTTP response is not delayed).

### Invoice Paid
When Stripe fires the `invoice.paid` webhook, the matching row's **Status** is updated to `paid` and **Paid At** is filled in.

### Invoice Voided
When you void an invoice in the portal, the matching row's **Status** is updated to `void`.

All ledger writes are non-blocking. If the Nextcloud write fails (network issue, etc.), an error is logged but the portal operation succeeds normally.

---

## Backfilling Existing Invoices

To seed the ledger with all invoices already in Stripe (run this once after setup):

```bash
curl -X POST https://your-api/api/v1/invoices/backfill-ledger \
  -H "Authorization: Bearer <admin-jwt-token>"
```

Response: `{ "backfilled": 42 }`

This fetches all Stripe invoices for `dfwsc_services` clients, sorts them oldest-first, and writes them to the ledger in one pass. It is safe to run again — it overwrites the file completely with a fresh pull from Stripe.

---

## Environment Variables

Add these to your `.env`:

```env
NEXTCLOUD_URL=https://cloud.dfwsc.com
NEXTCLOUD_USER=MessyGinger0804
NEXTCLOUD_APP_PASSWORD=<app-password-from-nextcloud-settings>
```

Generate an app password at: **Nextcloud → Settings → Security → Devices & Sessions → Create new app password**

If these variables are not set, all ledger sync operations are silently skipped — the rest of the portal works normally.

---

## Technical Details

**WebDAV:** The integration uses Nextcloud's WebDAV API (`/remote.php/webdav/`) with HTTP Basic auth. No Nextcloud SDK or extra npm package is needed — Node's built-in `fetch` handles it.

**Read-modify-write:** For updates (paid, void), the lib reads the current CSV, finds the row by Invoice ID (column 3), updates the Status and Paid At columns in place, and writes the file back.

**CSV escaping:** Values containing commas, quotes, or newlines are quoted per RFC 4180.

**File:** `backend/src/lib/nextcloud-ledger.ts`

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Rows not appearing | Verify `NEXTCLOUD_*` env vars are set and server was restarted |
| `Nextcloud write failed: 401` | App password may be wrong or expired — regenerate one |
| `Nextcloud write failed: 404` | The `clients/` folder or `dfwsc-ledger.csv` was deleted — re-run backfill |
| Paid At not filling in | Stripe webhook `invoice.paid` may not be forwarded locally — use `make up` (includes Stripe CLI) |
