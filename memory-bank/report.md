# DFWSC Security Review — `cleanup` Branch

**Date**: 2026-03-13
**Branch**: `cleanup` → `main`
**Reviewer**: Security audit of all changes introduced since `main`

---

## Overview

The `cleanup` branch resolves all 12 issues identified in the prior codebase audit. This report covers a focused security review of those changes. The net effect is a meaningfully hardened codebase with no high-confidence new vulnerabilities introduced.

---

## Prior Issues — Resolution Status

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | Critical | `FRONTEND_ORIGIN` multi-value breaks all redirect URLs | Fixed — `.split(',')[0].trim()` applied in `connect.ts`, `payments.ts` |
| 2 | Critical | nginx has no API proxy — all API calls 404 | Fixed — `/api/v1/` proxy block added to `front/nginx.conf` |
| 3 | High | `requireRole` trusts client-controlled `x-api-role` header | Fixed — function deleted from `lib/auth.ts` |
| 4 | High | `/onboard-client` and `/connect/refresh` have no rate limiting | Fixed — `rateLimit` preHandler added to both GET endpoints in `connect.ts` |
| 5 | Medium | O(n) bcrypt scan per API request | Fixed — SHA-256 indexed lookup path added; bcrypt only runs on the matched record |
| 6 | Medium | Rate limiter memory leak | Fixed — delete-on-empty + 10-minute sweep interval added to `rate-limit.ts` |
| 7 | Medium | Callback redirects to success when client not found | Fixed — returns 404 when client record is missing in `connect.ts` |
| 8 | Medium | No transactions for multi-step DB writes | Fixed — `db.transaction()` wraps both `connect/callback` and webhook processing |
| 9 | Medium | Plaintext API key column still in schema | Fixed — `apiKey` column dropped via `0003_drop_plaintext_api_key.sql`; `apiKeyLookup` added |
| 10 | Low | stripe-cli variable substitution likely empty | Fixed — `--api-key $STRIPE_SECRET_KEY` passed at runtime where `env_file` vars are available |
| 11 | Low | Postgres exposed on all interfaces (dev) | Fixed — `docker-compose.yml` now binds to `127.0.0.1:5432:5432` |
| 12 | Low | Admin setup flag non-durable across restarts | Fixed — flag written to disk via `SETUP_FLAG_PATH`; persists across container restarts |

---

## New Security Review Findings

### Candidates Evaluated

Three potential issues were identified in the new code and put through false-positive analysis:

| Finding | File | Confidence | Verdict |
|---------|------|------------|---------|
| Setup token header array type confusion | `routes/auth.ts:117` | 1/10 | **Filtered** — array ≠ string causes 401, not a bypass; DoS exclusion applies |
| Legacy API key fallback accepts non-`'active'` status | `lib/auth.ts:51` | 3/10 | **Filtered** — requires direct DB write access to introduce non-standard status values |
| PostgreSQL port 0.0.0.0 binding in prod compose | `docker-compose.prod.yml:50` | 7/10 | **Fixed** — `127.0.0.1:5432:5432` binding applied |

### Result: No findings meet the reporting threshold (≥ 8/10 confidence)

---

## Summary

The `cleanup` branch closes all outstanding audit items and introduces no high-confidence new vulnerabilities. The prod DB port binding observation was subsequently resolved — `docker-compose.prod.yml` now binds Postgres to `127.0.0.1:5432:5432`.
