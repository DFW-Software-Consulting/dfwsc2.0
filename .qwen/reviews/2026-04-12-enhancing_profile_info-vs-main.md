# Review: enhancing_profile_info vs main

**Date:** 2026-04-12
**Branch:** `enhancing_profile_info`
**Commits:** 3
- `feat: implement dual-mode billing (DFWSC vs Portal) with fee-on-top logic`
- `fix: allow admin jwt to authenticate payment link creation`
- `feat: split admin workflows by workspace and stabilize dev stack`

**Stats:** 48 files changed, ~1400 lines added, ~718 lines deleted

## Deterministic Analysis

- **Biome linter:** 2 warnings — missing `useCallback` deps in `CreateClientForm.jsx:31` (`isDfwscMode`, `workspace`) — fixable
- **TypeScript:** No new type errors in changed source files (existing errors are in node_modules/drizzle-orm and pre-existing test files)

## Verdict: Request Changes

6 Critical findings, 7 Suggestions, several minor items.

### Critical

1. **Migration defaults all existing clients/groups to `client_portal`** — no backfill for `dfwsc_services`. (`backend/drizzle/0002_curious_icarus.sql`)
2. **`requireClientOrAdmin` silently swallows auth errors** — DB failures masked. (`backend/src/routes/payments.ts:22-37`)
3. **`baseAmount` falls back to `0` for price ID line items** — undercharged fees. (`backend/src/routes/payments.ts:237-241`)
4. **No validation on `processingFeePercent` range** — negative or extreme values allowed. (`backend/src/routes/payments.ts:97`, `stripe-billing.ts:69`)
5. **`SubscriptionsTab` missing interval selector + disabled state** — UX bug. (`front/src/components/admin/BillingPanel.jsx:630-750`)
6. **Missing `useCallback` deps in CreateClientForm** — stale closure, wrong workspace. (`front/src/components/admin/CreateClientForm.jsx:31`) — biome auto-fixable

### Suggestions

7. `resolveClientFee` duplicated in payments.ts and stripe-billing.ts
8. `/onboard-client/resend` lacks workspace scoping (global email lookup)
9. `/onboard-client/initiate` hardcodes `client_portal` workspace
10. Seed script inserts no `dfwsc_services` test data
11. No test coverage for `waiveFee` parameter
12. `Promise.all` in group report can trigger Stripe rate limits
13. Hook defaults overwritten by explicit `{ workspace: undefined }`

### Needs Human Review

- Onboard email branding hardcoded to "DFW Software Consulting" for all workspaces
- API container runs `npm install` on every start (slow cold-boot)
- Invoice/subscription endpoints lack workspace validation across workspaces
