# Documentation Overview

This directory mirrors the runtime layout of the Stripe Payment Portal so that developers can jump from code to supporting guides without guesswork. Each Markdown file begins with the path of the module it explains, lists the dependencies (including environment variables), and captures common debugging and testing tips.

## Structure

```
documentation/
├── README.md
├── CHANGELOG.md
├── src/
│   ├── server.md
│   ├── lib/
│   │   ├── stripe.md
│   │   └── mailer.md
│   └── routes/
│       ├── accounts.md
│       ├── payments.md
│       ├── webhooks.md
│       └── reports.md
├── db/
│   ├── schema.md
│   └── migrations.md
└── docs/
    ├── api.md
    ├── env_setup.md
    ├── env_setup_nextcloud.md
    ├── email_setup.md
    ├── stripe_setup.md
    ├── deployment.md
    └── testing.md
```

## How to Use This Directory

- **Start with `docs/`** for project-wide guidance on environment preparation, running tests, or deploying to production.
- **Drill into `src/`** to understand a specific Fastify module, including example cURL requests that exercise each endpoint.
- **Visit `db/`** when you need to inspect database shape or run migrations.
- **Keep `CHANGELOG.md`** up to date as you add, update, or retire documentation so contributors can track the history of these guides.

Every file is meant to be short enough to read in a few minutes and detailed enough to operate the service in isolation.
