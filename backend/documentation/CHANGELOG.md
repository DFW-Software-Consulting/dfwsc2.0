# Documentation Changelog

## 2026-01-18
- Expanded top-level README troubleshooting and container healthcheck/logging guidance.
- Added frontend architecture/build details and admin token lifecycle notes.
- Added API error/pagination conventions and environment matrix.
- Documented webhook handling policy, security controls, and testing strategy.
- Added deployment ops guidance (monitoring, backups, incident response) and template ownership for email.
- Added contributor and release process docs.

## 2025-10-26
- Documented the Vitest mail delivery stubs and noted that unit tests no longer require Docker services.
- Added guidance for running `make test-stripe` and customizing the connected account placeholder in
  `test-stripe-events.sh`.

## 2025-10-25
- Initial structured documentation pass that mirrors `src/` and `db/` modules.
- Added setup, testing, and deployment guides under `documentation/docs/`.
- Captured onboarding, payments, webhook, and reporting flows with example API requests.
