# src/routes/webhooks.ts

## Purpose
Processes incoming Stripe webhook events. Validates the signature, stores raw payloads in Postgres, logs notable events, and marks each event as processed.

## Dependencies
- `STRIPE_WEBHOOK_SECRET` — **required** at module load; the app throws immediately if missing.
- Database: inserts/updates the `webhook_events` table.
- Stripe SDK: `stripe.webhooks.constructEvent` for signature verification.
- Requires Fastify `rawBody` support (enabled in `src/app.ts`).

## Key Endpoint
- `POST /webhooks/stripe`
  - Headers: `Stripe-Signature` from Stripe.
  - Body: raw JSON payload forwarded by Stripe.
  - Stores each event (idempotent via `onConflictDoNothing`), logs select event types, and returns `{ received: true }`.

## Example Usage
```bash
# Forward events from Stripe CLI to your local server
stripe listen --forward-to localhost:4242/webhooks/stripe

# Trigger a test payment_intent.succeeded event
stripe trigger payment_intent.succeeded
```

## Testing & Debugging Notes
- Check `webhook_events` table to confirm persistence: `SELECT type, processed_at FROM webhook_events ORDER BY created_at DESC;`.
- Server logs include info-level entries for payment, charge, and payout events—use `docker compose logs -f api` in containerized setups.
- Vitest covers signature failures and event persistence (`src/__tests__/app.test.ts`). Run `npm test` before pushing changes.
- If signature verification fails, ensure the webhook secret matches the Stripe CLI session or live endpoint.

## Event Handling Policy
- **Idempotency**: events are stored with `stripe_event_id` and deduplicated using `onConflictDoNothing`.
- **Retries**: Stripe retries webhook delivery on non-2xx responses; this route always returns `200` when validation succeeds.
- **Alerting**: monitor API logs and `webhook_events.processed_at` for gaps or repeated failures.
