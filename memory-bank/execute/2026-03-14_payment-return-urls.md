---
title: "Payment Return URLs Per Client – Execution Log"
phase: Execute
date: "2026-03-14"
owner: "dev"
plan_path: "memory-bank/plan/2026-03-14_00-06-37_payment-return-urls.md"
start_commit: "fbd30b3"
env: {target: "local", notes: "Docker dev stack, cleanup branch"}
---

## Pre-Flight Checks
- DoR satisfied? YES
  - Docker dev stack runnable (make up)
  - Drizzle CLI accessible (npm run db:generate / db:migrate inside container)
  - Existing 0003 migration applied
- Access/secrets present? YES (dev .env)
- Fixtures/data ready? YES (existing test suite with in-memory DB mock)

---

## Rollback Point
- Commit: fbd30b3
- To rollback: `git checkout fbd30b3`

---

## Task T1 – Extend Drizzle Schema

**Status:** DONE

**Files:** `backend/src/db/schema.ts`

Added two nullable text fields to the `clients` table:
- `paymentSuccessUrl: text("payment_success_url")` — nullable, no default
- `paymentCancelUrl: text("payment_cancel_url")` — nullable, no default

**Commit:** (see atomic T1+T2 commit below)

---

## Task T2 – Generate + Review Migration

**Status:** DONE

**Files:** `backend/drizzle/0004_add_client_return_urls.sql`, `backend/drizzle/meta/_journal.json`

Created migration manually (cannot run `npm run db:generate` outside container).
SQL reviewed and matches acceptance criteria:
- `ALTER TABLE "clients" ADD COLUMN "payment_success_url" text;`
- `ALTER TABLE "clients" ADD COLUMN "payment_cancel_url" text;`
- No NOT NULL constraint

Journal updated with idx 4, tag `0004_add_client_return_urls`.

**Note:** Run `npm run db:migrate` inside the running container after merging.

---

## Task T3 – Extend PATCH /clients/:id

**Status:** DONE

**Files:** `backend/src/routes/clients.ts`

Changes:
- `ClientPatchBody.status` made optional (`?`)
- Added `paymentSuccessUrl?: string | null` and `paymentCancelUrl?: string | null` to `ClientPatchBody`
- Added inline `isValidHttpsUrl` helper (URL constructor + `protocol === 'https:'`)
- Status validation now guards on `status !== undefined` before checking values
- URL validation: non-null values must pass HTTPS check → 400 otherwise
- `.set()` uses conditional update object to only touch provided fields
- Response payload includes `paymentSuccessUrl` and `paymentCancelUrl`

---

## Task T4 – Use Per-Client URLs in Checkout Session

**Status:** DONE

**Files:** `backend/src/routes/payments.ts`

Replaced hardcoded `success_url`/`cancel_url` with nullish coalescing fallback:
```ts
success_url: client.paymentSuccessUrl
  ?? `${frontendOrigin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
cancel_url: client.paymentCancelUrl
  ?? `${frontendOrigin}/payment-cancel`,
```
No other changes to this file.

---

## Task T5 – Integration Test

**Status:** DONE

**Files:** `backend/src/__tests__/app.test.ts`

Added one test inside `describe('payments')`:
> When `USE_CHECKOUT=true` and `client.paymentSuccessUrl` is set, `stripe.checkout.sessions.create` is called with that URL as `success_url`.

Seeded client directly in `dataStore.clients` with `paymentSuccessUrl: 'https://myclient.com/thank-you'`.

---

## Gate Results

### Gate C (Pre-merge)
- TypeScript compile: PENDING — run `tsc --noEmit` inside container
- Migration SQL: REVIEWED — matches acceptance criteria
- Existing tests: PENDING — run `make test`
- T5 test: PENDING — run `make test`

---

## Post-Run Update

*(To be filled after `make test` is run inside container)*

---

## Follow-ups
- Run `npm run db:migrate` inside container after merge to apply 0004 migration
- Manual test: set `USE_CHECKOUT=true`, PATCH a client with `paymentSuccessUrl`, trigger a payment
- CLAUDE.md note (optional): client-provided URLs do NOT append `{CHECKOUT_SESSION_ID}` — that's only for the fallback URL

## References
- Plan: `memory-bank/plan/2026-03-14_00-06-37_payment-return-urls.md`
- Ticket: `memory-bank/tickets/2026-01-27_payment-return-urls.md`
