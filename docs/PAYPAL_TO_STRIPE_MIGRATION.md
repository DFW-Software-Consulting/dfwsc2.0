> **Historical / superseded (2026-11-06).** This document reflects the codebase as of 2026-04-12. It is not maintained and some instructions would reintroduce removed or insecure behavior. Current docs: [docs/](./)

# PayPal to Stripe Migration (Completed)

This migration is complete. Stripe is now the sole payment system.

Historical invoices that were originally processed through PayPal were imported into Stripe as out-of-band paid invoices. Original PayPal IDs and dates were preserved in Stripe invoice metadata (`source=paypal`, original PayPal invoice ID, original issue date).

There is no ongoing migration work. This file is retained for audit trail purposes only.
