# PayPal to Stripe Migration

## Goal
Use Stripe as the central system for customer invoices and payment tracking, including legacy invoices that were originally paid through PayPal.

## What We Can Do
- Import or create Stripe customers.
- Create Stripe invoices and invoice items for historical records.
- Mark invoices as paid out of band for non-Stripe payments (for example, PayPal).
- Add metadata to preserve source and audit trail (for example, `source=paypal`, original PayPal invoice ID, and original issue date).

## Important Limitations
- Stripe generally does not allow backdating the internal `created` timestamp to an arbitrary historical date.
- For historical accuracy, store original dates in invoice fields/metadata and include them in reporting.

## Recommended Approach
1. Export historical invoice/customer data from PayPal.
2. Build a repeatable migration script (Node.js or Python) using Stripe API.
3. Create customers first, then invoices/invoice items.
4. Mark imported historical invoices as paid out of band.
5. Keep references to original PayPal IDs and dates in metadata.

## Tooling Note
- Stripe CLI can be used for quick/manual operations.
- For bulk migration and reliable bookkeeping, use scripted API calls instead of one-off CLI commands.

## Next Step
Define the migration input format (CSV or API export) and implement a dry-run capable importer.
