# Plans

Design plans written for earlier work. They are historical records, not current documentation. Current documentation is in [docs/](../docs/). Status below is as of 2026-11-06 and was checked against the code.

| Plan | Status | Notes |
|------|--------|-------|
| [api-consistency.md](./api-consistency.md) | Done | Error helper, paginated list envelope and 204 deletes shipped as described in its banner. Step 4c (`buildOnboardingEmail`) was not done. |
| [backend-resilience.md](./backend-resilience.md) | Superseded | Do not implement. Checkout-only payments, webhook leases, 502 on mail failure and the custom Redis-capable limiter replaced its steps. |
| [cerebo.md](./cerebo.md) | Active | Phase 1 shipped behind `CEREBO_ENABLED` (default off). Phases 2 to 4 not started. Whether Cerebo stays is an owner decision. |
| [database-schema-indexes.md](./database-schema-indexes.md) | Superseded | Do not re-add `invoices`. Open: CHECK constraints on the fee fields. |
| [devops-monitoring-infra.md](./devops-monitoring-infra.md) | Superseded | Sentry, Prometheus and a deploy workflow were never added. Deployment is Coolify with Loki log shipping. |
| [frontend-architecture.md](./frontend-architecture.md) | Done (one step open) | Lazy routes, memoized contexts and the modal focus trap shipped. The httpOnly-cookie JWT step is open. |
| [security-hardening.md](./security-hardening.md) | Superseded | `/auth/setup` is gone, the proposed CSP is weaker than the shipped one, TLS is terminated by the platform proxy. |

Related historical material: [reports/deep-review-20260315.md](../reports/deep-review-20260315.md), the four files in [reviews/](../reviews/), and [docs/PAYPAL_TO_STRIPE_MIGRATION.md](../docs/PAYPAL_TO_STRIPE_MIGRATION.md) all carry a historical banner.
