# src/db/schema.ts

## Purpose
Defines the Drizzle ORM schema for the service: client companies, onboarding tokens, and stored Stripe webhook payloads.

## Tables
- `clients`
  - Columns: `id`, `name`, `email`, `stripe_account_id`, `created_at`, `updated_at`.
  - Stores the mapping between internal client IDs and Stripe Express accounts.
- `webhook_events`
  - Columns: `id`, `stripe_event_id`, `type`, `payload`, `processed_at`, `created_at`.
  - Persists every webhook for auditing and replay.
- `onboarding_tokens`
  - Columns: `id`, `client_id`, `token`, `status`, `email`, `created_at`, `updated_at`.
  - Tracks issued onboarding JWTs and their lifecycle.

## Example Usage
```ts
import { db } from '../db/client';
import { clients } from '../db/schema';
import { eq } from 'drizzle-orm';

const [client] = await db.select().from(clients).where(eq(clients.id, 'client_123')).limit(1);
```

## Testing & Debugging Notes
- Run `psql $DATABASE_URL -c "\dt"` to confirm tables exist after migrations.
- Keep schema changes synchronized with the routes; add documentation updates here when new columns/tables land.
- Automated schema drift detection runs at startup via `src/lib/schema-check.ts`; failures indicate migrations need to be re-run.
