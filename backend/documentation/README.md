# Documentation moved

This directory previously held a parallel set of module-by-module docs
(`src/`, `db/`, `docs/` subtrees). It was retired: it documented contracts
that no longer exist (a `PaymentIntent`-based `clientSecret` response shape,
a `src/server.ts` entry point that isn't part of this codebase) and drifted
out of sync with the current routes.

For accurate, maintained documentation, see:

- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — system overview and entry point
- [docs/BACKEND.md](../../docs/BACKEND.md) — API, logic, and auth
- [docs/DATABASE.md](../../docs/DATABASE.md) — schema and migrations
- [docs/STRIPE.md](../../docs/STRIPE.md) — Connect, webhooks, and payments
- [API_DOCS.md](../../API_DOCS.md) — API reference
