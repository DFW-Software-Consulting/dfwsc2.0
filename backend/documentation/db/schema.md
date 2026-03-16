# src/db/schema.ts

## Purpose
Defines the Drizzle ORM schema for the service: client groups, client companies, onboarding tokens, and stored Stripe webhook payloads.

## Tables

### `clientGroups`
Stores client group configurations for shared settings across multiple clients.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | text | PRIMARY KEY | Unique identifier |
| `name` | text | NOT NULL | Group name |
| `status` | text | NOT NULL, DEFAULT 'active' | Enum: `active` \| `inactive` |
| `processingFeePercent` | numeric(5,2) | NULL | Processing fee percentage (e.g., 2.50) |
| `processingFeeCents` | integer | NULL | Fixed processing fee in cents |
| `paymentSuccessUrl` | text | NULL | Redirect URL after successful payment |
| `paymentCancelUrl` | text | NULL | Redirect URL after cancelled payment |
| `createdAt` | timestamp | DEFAULT NOW() | Record creation time |
| `updatedAt` | timestamp | DEFAULT NOW() | Last update time |

### `clients`
Stores client company records and their Stripe Connect account mappings.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | text | PRIMARY KEY | Unique identifier |
| `name` | text | NOT NULL | Client company name |
| `email` | text | NOT NULL | Client contact email |
| `apiKeyHash` | text | UNIQUE | Bcrypt hash of API key (for verification) |
| `apiKeyLookup` | text | UNIQUE | SHA-256 hash of API key (for O(1) lookup) |
| `stripeAccountId` | text | NULL | Stripe Connect account ID (e.g., `acct_...`) |
| `status` | text | NOT NULL, DEFAULT 'active' | Enum: `active` \| `inactive` |
| `groupId` | text | FK → clientGroups.id | Optional client group association |
| `paymentSuccessUrl` | text | NULL | Override success URL (group fallback) |
| `paymentCancelUrl` | text | NULL | Override cancel URL (group fallback) |
| `processingFeePercent` | numeric(5,2) | NULL | Override fee % (group fallback) |
| `processingFeeCents` | integer | NULL | Override fixed fee (group fallback) |
| `createdAt` | timestamp | DEFAULT NOW() | Record creation time |
| `updatedAt` | timestamp | DEFAULT NOW() | Last update time |

**Indexes:**
- `clients_api_key_hash_idx` on `apiKeyHash`
- `clients_api_key_lookup_idx` on `apiKeyLookup`

### `webhook_events`
Persists all Stripe webhook events for auditing and replay.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | text | PRIMARY KEY | Unique identifier |
| `stripeEventId` | text | NOT NULL, UNIQUE | Stripe event ID (e.g., `evt_...`) |
| `type` | text | NOT NULL | Event type (e.g., `payment_intent.succeeded`) |
| `payload` | jsonb | NOT NULL | Full Stripe event payload |
| `processedAt` | timestamp | NULL | When the event was processed |
| `createdAt` | timestamp | DEFAULT NOW() | Record creation time |

### `onboarding_tokens`
Tracks issued onboarding tokens and their lifecycle through Stripe Connect onboarding.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | text | PRIMARY KEY | Unique identifier |
| `clientId` | text | NOT NULL, FK → clients.id | Associated client (cascade delete) |
| `token` | text | NOT NULL, UNIQUE | Secure token for onboarding flow |
| `status` | text | NOT NULL | Token status: `pending` \| `in_progress` \| `completed` \| `expired` |
| `email` | text | NOT NULL | Client email at token creation |
| `state` | text | NULL | CSRF state for Stripe OAuth callback |
| `stateExpiresAt` | timestamp | NULL | State token expiration (30 min from creation) |
| `createdAt` | timestamp | DEFAULT NOW() | Record creation time |
| `updatedAt` | timestamp | DEFAULT NOW() | Last update time |

## Relationships

```
clientGroups (1) ──→ (∞) clients (group association)
clients    (1) ──→ (∞) onboarding_tokens (cascade delete)
```

## Example Usage

```ts
import { db } from '../db/client';
import { clients, clientGroups, webhookEvents, onboardingTokens } from '../db/schema';
import { eq, and } from 'drizzle-orm';

// Find client by API key lookup hash
const [client] = await db
  .select()
  .from(clients)
  .where(eq(clients.apiKeyLookup, 'sha256_hash_here'))
  .limit(1);

// Get client with group info
const [clientWithGroup] = await db
  .select({
    client: clients,
    group: clientGroups,
  })
  .from(clients)
  .leftJoin(clientGroups, eq(clients.groupId, clientGroups.id))
  .where(eq(clients.id, 'client_123'))
  .limit(1);

// Store webhook event
await db.insert(webhookEvents).values({
  id: `wev_${Date.now()}`,
  stripeEventId: 'evt_123',
  type: 'payment_intent.succeeded',
  payload: eventPayload,
});

// Find pending onboarding token
const [token] = await db
  .select()
  .from(onboardingTokens)
  .where(and(
    eq(onboardingTokens.token, 'token_abc'),
    eq(onboardingTokens.status, 'pending')
  ))
  .limit(1);
```

## Testing & Debugging Notes

- Run `psql $DATABASE_URL -c "\dt"` to confirm tables exist after migrations.
- Run `psql $DATABASE_URL -c "\d clients"` to inspect column details.
- Keep schema changes synchronized with the routes; add documentation updates here when new columns/tables land.
- Automated schema drift detection runs at startup via `src/lib/schema-check.ts`; failures indicate migrations need to be re-run.
- API key authentication uses a two-step process: SHA-256 lookup (`apiKeyLookup`) for O(1) database query, then bcrypt verification (`apiKeyHash`) for security.
