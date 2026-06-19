# Plan: Database Schema & Performance

## Goal
Fix schema drift, add missing indexes, enforce data integrity constraints, configure the connection pool, and resolve the N+1 legacy API key scan.

## Current State
- `invoices` table exists in migration `0014` but has no Drizzle schema definition → Drizzle will try to DROP it
- `stripeAccountId`, `groupId`, `onboardingTokens.clientId`, `clientGroups.workspace` lack indexes
- `onboardingTokens.status` is unconstrained text (should be enum)
- `processingFeePercent` has no CHECK constraint
- `clients.groupId` FK missing `onDelete` behavior
- Connection pool has zero configuration (`db/client.ts:4`)
- Redundant indexes on `apiKeyHash` and `apiKeyLookup` (unique already creates index)
- Client factory uses manual rollback instead of transaction
- `onboardingTokens` tokens stored as plaintext (not hashed)

---

## Step 1: Add `invoices` table to Drizzle schema

**File:** `backend/src/db/schema.ts`

Add the missing table definition that matches migration `0014_flat_triton.sql`:

```typescript
export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  invoiceNumber: text("invoice_number").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").default("usd").notNull(),
  status: text("status", { enum: ["draft", "sent", "paid", "overdue", "void"] })
    .default("draft")
    .notNull(),
  dueDate: timestamp("due_date", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  stripeInvoiceId: text("stripe_invoice_id"),
  nextcloudId: text("nextcloud_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
```

**Verification:** Run `npm run db:generate` → no migration should attempt to drop `invoices`.

---

## Step 2: Add missing indexes

**File:** `backend/src/db/schema.ts`

Add these indexes in the table callback functions:

```typescript
// In clients table (add to the callback at line 64-68):
stripeAccountIdIdx: index("clients_stripe_account_id_idx").on(table.stripeAccountId),
groupIdIdx: index("clients_group_id_idx").on(table.groupId),
workspaceIdx: index("clients_workspace_idx").on(table.workspace),

// In onboardingTokens table (add callback):
export const onboardingTokens = pgTable("onboarding_tokens", {
  // ... existing columns ...
}, (table) => ({
  clientIdStateIdx: index("onboarding_tokens_client_state_idx").on(table.clientId, table.state),
}));

// In clientGroups table (add callback):
export const clientGroups = pgTable("client_groups", {
  // ... existing columns ...
}, (table) => ({
  workspaceIdx: index("client_groups_workspace_idx").on(table.workspace),
}));
```

Create a migration:

```bash
npm run db:generate
```

**Verification:** Run `EXPLAIN ANALYZE` on queries that filter by `stripeAccountId`, `groupId`, `workspace` → should use index scans instead of sequential scans.

---

## Step 3: Remove redundant indexes

**File:** `backend/src/db/schema.ts`

Lines 65-66 create explicit indexes on `apiKeyHash` and `apiKeyLookup`, but `.unique()` on lines 39-40 already creates unique B-tree indexes.

```typescript
// REMOVE these lines (65-66):
apiKeyHashIdx: index("clients_api_key_hash_idx").on(table.apiKeyHash),
apiKeyLookupIdx: index("clients_api_key_lookup_idx").on(table.apiKeyLookup),
```

Generate migration to drop them:

```bash
npm run db:generate
```

**Verification:** `npm run db:generate` produces a migration that drops `clients_api_key_hash_idx` and `clients_api_key_lookup_idx`.

---

## Step 4: Add enum constraint on `onboardingTokens.status`

**File:** `backend/src/db/schema.ts`

```typescript
// BEFORE (line 86)
status: text("status").notNull(),

// AFTER
status: text("status", { enum: ["pending", "in_progress", "completed", "revoked"] }).notNull(),
```

Add a CHECK constraint in the generated migration:

```sql
ALTER TABLE onboarding_tokens
  ADD CONSTRAINT onboarding_tokens_status_check
  CHECK (status IN ('pending', 'in_progress', 'completed', 'revoked'));
```

**Verification:** Try to insert `status = 'garbage'` → constraint violation.

---

## Step 5: Add CHECK constraints on fee fields

**File:** `backend/src/db/schema.ts`

After generating the migration, add CHECK constraints:

```sql
-- In the generated migration file:
ALTER TABLE clients
  ADD CONSTRAINT clients_fee_percent_check
  CHECK (processing_fee_percent IS NULL OR (processing_fee_percent > 0 AND processing_fee_percent <= 100));

ALTER TABLE clients
  ADD CONSTRAINT clients_fee_cents_check
  CHECK (processing_fee_cents IS NULL OR processing_fee_cents >= 0);

ALTER TABLE clients
  ADD CONSTRAINT clients_fee_exclusive_check
  CHECK (processing_fee_percent IS NULL OR processing_fee_cents IS NULL);

ALTER TABLE client_groups
  ADD CONSTRAINT client_groups_fee_percent_check
  CHECK (processing_fee_percent IS NULL OR (processing_fee_percent > 0 AND processing_fee_percent <= 100));

ALTER TABLE client_groups
  ADD CONSTRAINT client_groups_fee_cents_check
  CHECK (processing_fee_cents IS NULL OR processing_fee_cents >= 0);

ALTER TABLE client_groups
  ADD CONSTRAINT client_groups_fee_exclusive_check
  CHECK (processing_fee_percent IS NULL OR processing_fee_cents IS NULL);
```

**Verification:** Try to insert `processing_fee_percent = 150` → constraint violation. Try to set both percent and cents → constraint violation.

---

## Step 6: Add `onDelete` to `clients.groupId` FK

**File:** `backend/src/db/schema.ts`

```typescript
// BEFORE (line 46)
groupId: text("group_id").references(() => clientGroups.id),

// AFTER
groupId: text("group_id").references(() => clientGroups.id, { onDelete: "set null" }),
```

**Verification:** Delete a group that has clients → clients' `groupId` becomes `NULL` instead of throwing FK violation.

---

## Step 7: Configure connection pool

**File:** `backend/src/db/client.ts`

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX ?? "10", 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Handle pool errors
pool.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
  process.exit(1);
});

export const db = drizzle(pool);
export { pool };
```

**Verification:** Monitor active connections under load → should not exceed `DB_POOL_MAX`. Idle connections should be released after 30s.

---

## Step 8: Remove legacy API key full-scan fallback

**File:** `backend/src/lib/auth.ts`

After creating a migration script to populate `apiKeyLookup` for all legacy clients:

```typescript
// scripts/migrate-legacy-keys.ts
import { db } from "../src/db/client";
import { clients } from "../src/db/schema";
import { isNull } from "drizzle-orm";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

async function migrate() {
  const legacyClients = await db.select().from(clients).where(isNull(clients.apiKeyLookup));
  console.log(`Found ${legacyClients.length} legacy clients to migrate`);

  for (const client of legacyClients) {
    // Generate a new API key and populate apiKeyLookup
    const newApiKey = `dfwsc_${crypto.randomBytes(32).toString("hex")}`;
    const lookup = crypto.createHash("sha256").update(newApiKey).digest("hex");
    const hash = await bcrypt.hash(newApiKey, 10);

    await db.update(clients)
      .set({ apiKeyLookup: lookup, apiKeyHash: hash })
      .where(clients.id, client.id);

    console.log(`Client ${client.name}: new API key = ${newApiKey}`);
  }
}

migrate().catch(console.error);
```

Then remove lines 42-52 from `auth.ts` (the legacy fallback).

**Verification:** All clients have `apiKeyLookup` populated. `requireApiKey` only uses the fast SHA-256 path.

---

## Step 9: Add `NOT NULL` to `admins.role` and `admins.active`

**File:** `backend/src/db/schema.ts`

```typescript
// BEFORE (lines 98-99)
role: text("role").default("admin"),
active: boolean("active").default(true),

// AFTER
role: text("role").notNull().default("admin"),
active: boolean("active").notNull().default(true),
```

**Verification:** `npm run db:generate` → migration adds NOT NULL with defaults for existing rows.

---

## Verification Plan
1. `npm run db:generate` → no migration drops `invoices` table
2. `EXPLAIN ANALYZE` on `WHERE stripe_account_id = 'acct_xxx'` → uses index
3. `INSERT INTO onboarding_tokens (status) VALUES ('garbage')` → constraint violation
4. `INSERT INTO clients (processing_fee_percent) VALUES (150)` → constraint violation
5. Delete a group with clients → clients' `groupId` becomes NULL
6. Connection pool respects `DB_POOL_MAX` under load
7. All clients have `apiKeyLookup` populated after migration
8. `npm run db:generate` produces migration to drop redundant indexes

## Risks
- CHECK constraints on fee fields must not break existing data — verify before applying
- `onDelete: "set null"` changes existing FK behavior — test with production-like data
- Connection pool config may need tuning based on actual production load
- Legacy key migration script must be run once — verify all clients are migrated before removing fallback
