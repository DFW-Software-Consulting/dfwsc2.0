# PROJECT_STRUCTURE_REVIEW.md

## Accurate Directory Tree

```
.
├── .dockerignore               # Docker ignore file
├── .env                        # Environment variables (local)
├── .gitignore                  # Git ignore file
├── docker-cheat-sheet.md       # Markdown cheat sheet for Docker commands
├── docker-compose.ngrok.yml    # Docker Compose configuration for ngrok integration
├── docker-compose.prod.yml     # Docker Compose configuration for production environment
├── docker-compose.yml          # Docker Compose configuration for development environment
├── Dockerfile                  # Dockerfile for building the application image
├── drizzle.config.ts           # Drizzle ORM configuration
├── env.example                 # Example environment variables file
├── Makefile                    # Makefile for common development and deployment tasks
├── makefile_cheatsheet.md      # Markdown cheat sheet for Makefile commands
├── package-lock.json           # Node.js dependency lock file
├── package.json                # Node.js project metadata and scripts
├── README.md                   # Project README file
├── stripe_listen.log           # Log file for Stripe webhook listener
├── test                        # Directory for test files (e.g., integration tests)
├── test-stripe-webhooks.sh     # Script for testing Stripe webhooks
├── tsconfig.build.json         # TypeScript configuration for build process
├── tsconfig.json               # TypeScript configuration for the project
├── vitest.config.ts            # Vitest testing framework configuration
├── docs/                       # General project documentation
│   ├── fastify-stripe-connect.md # Detailed documentation on Fastify and Stripe Connect
│   └── stripe-platform.md      # Overview of the Stripe platform integration
├── documentation/              # Auto-generated documentation for source files
│   └── src/                    # Source code documentation mirror
│       ├── server.ts.md        # Documentation for the main server file
│       ├── db/                 # Documentation for database-related source files
│       │   ├── client.ts.md    # Documentation for the Drizzle client
│       │   └── schema.ts.md    # Documentation for the database schema
│       ├── lib/                # Documentation for utility and library source files
│       │   ├── env.ts.md       # Documentation for environment variable handling
│       │   ├── schema-check.ts.md # Documentation for database schema validation
│       │   └── stripe.ts.md    # Documentation for Stripe SDK initialization
│       ├── routes/             # Documentation for API route source files
│       │   ├── accounts.ts.md  # Documentation for accounts and onboarding routes
│       │   ├── admin.ts.md     # Documentation for admin routes
│       │   ├── health.ts.md    # Documentation for health check route
│       │   ├── payments.ts.md  # Documentation for payments and financial operations routes
│       │   ├── webhooks.ts.md  # Documentation for Stripe webhook handler
│       │   └── __tests__/      # Documentation for route-specific test files
│       │       ├── accounts.test.ts.md # Documentation for accounts route tests
│       │       └── onboarding-payment-flow.test.ts.md # Documentation for onboarding payment flow tests
├── drizzle/                    # Drizzle ORM migration files
│   ├── 0000_glamorous_phil_sheldon.sql # First database migration script
│   ├── 0001_black_zarda.sql    # Second database migration script
│   └── meta/                   # Drizzle ORM migration metadata
│       ├── 0000_snapshot.json  # Drizzle schema snapshot
│       ├── _journal.json       # Drizzle migration journal
│       └── 0001_snapshot.json  # Drizzle schema snapshot
├── public/                     # Static assets served by the application
│   ├── admin-token-generator.html # HTML for admin token generation
│   ├── client-onboard.html     # HTML for client onboarding
│   ├── config.js               # Frontend configuration
│   └── index.html              # Main index HTML file
├── scripts/                    # Utility scripts
│   └── db-url-field.mjs        # Script for database URL field manipulation
└── src/                        # Application source code
    ├── server.ts               # Main application server entry point
    ├── db/                     # Database client and schema definitions
    │   ├── client.ts           # Drizzle ORM client initialization
    │   └── schema.ts           # Database schema definition
    ├── lib/                    # Utility functions and libraries
    │   ├── env.ts              # Environment variable handling
    │   ├── schema-check.ts     # Database schema validation logic
    │   └── stripe.ts           # Stripe SDK initialization
    └── routes/                 # API route definitions
        ├── accounts.ts         # Routes for accounts and onboarding
        ├── admin.ts            # Routes for administrative tasks
        ├── health.ts           # Health check route
        ├── payments.ts         # Routes for payments and financial operations
        ├── webhooks.ts         # Stripe webhook handler
        └── __tests__/          # Unit and integration tests for routes
            └── accounts.test.ts # Tests for accounts routes
```

## Notes on Mismatches or Outdated References

1.  **Missing Test File**: The `docs/fastify-stripe-connect.md` and `documentation/src/routes/__tests__/onboarding-payment-flow.test.ts.md` both reference `src/routes/__tests__/onboarding-payment-flow.test.ts`. However, this file is not present in the current codebase based on the directory scan. This suggests the test file was either removed or renamed without updating the documentation.

2.  **Incomplete Directory Structure in `docs/fastify-stripe-connect.md`**: The "Directory Structure" section in `docs/fastify-stripe-connect.md` is missing several top-level files and directories that are part of the project. These include:
    *   `.env`
    *   `.dockerignore`
    *   `docker-cheat-sheet.md`
    *   `docker-compose.ngrok.yml`
    *   `docker-compose.prod.yml`
    *   `Makefile`
    *   `makefile_cheatsheet.md`
    *   `package-lock.json`
    *   `stripe_listen.log`
    *   `test/` (general test directory)
    *   `tsconfig.build.json`
    *   `vitest.config.ts`
    *   `drizzle/` (with its migration files and `meta` subdirectory)
    *   `documentation/` (the directory containing auto-generated docs)

## Suggested Fixes or Doc Updates

1.  **Update `docs/fastify-stripe-connect.md` Directory Structure**:
    *   Remove the reference to `src/routes/__tests__/onboarding-payment-flow.test.ts`.
    *   Add all missing top-level files and directories identified above to provide a complete and accurate project structure overview.
    *   Add concise one-line descriptions for each entry in the directory structure within `docs/fastify-stripe-connect.md` for better clarity.

2.  **Review `documentation/src/routes/__tests__/onboarding-payment-flow.test.ts.md`**: Since the corresponding source file is missing, this documentation file is now orphaned. It should either be removed or the source file should be restored if its absence is unintentional.

3.  **Clarify `documentation/` Purpose**: Add a note in `README.md` or `docs/fastify-stripe-connect.md` explaining that the `documentation/src/` directory contains auto-generated documentation for the source code files.

## Current Environment & Build Commands Summary

### Environment Variables

The project relies on several environment variables for configuration, as detailed in `env.example` and `docs/fastify-stripe-connect.md`. Key variables include:

*   `STRIPE_SECRET_KEY`: Stripe API secret key.
*   `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret.
*   `PLATFORM_FEE_FLAT_CENTS`: Flat platform fee in cents.
*   `ONBOARDING_RETURN_URL`: URL for Stripe onboarding completion redirect.
*   `ONBOARDING_REFRESH_URL`: URL for Stripe onboarding retry redirect.
*   `ONBOARDING_TOKEN_TTL_HOURS`: TTL for onboarding tokens (defaults to 24).
*   `CLIENT_ONBOARD_URL`: Base URL for client onboarding UI hints.
*   `FRONTEND_URL`: Base URL for frontend redirects.
*   `JWT_SECRET`: JWT secret for general use (per-company secrets are stored in DB).
*   `PORT`: HTTP server port (defaults to 4242).
*   `DATABASE_URL`: PostgreSQL connection string.

These are validated at startup by `src/lib/env.ts`.

### Build and Development Commands

The project uses `npm` scripts and `Makefile` for various tasks:

*   **`make dev`**: Starts the application and Postgres via Docker Compose, runs migrations, and enables hot-reloading.
*   **`make logs`**: Follows application logs.
*   **`make down`**: Stops and removes Docker services.
*   **`make migrate`**: Runs Drizzle database migrations.
*   **`make prod`**: Builds and runs the production Docker image.
*   **`make prod-logs`**: Follows production application logs.
*   **`make stop-prod`**: Stops the production container.
*   **`REGISTRY_URL=<your-registry> make tag-and-push`**: Tags and pushes Docker image to a registry.
*   **`npm run build`**: Compiles TypeScript to JavaScript in the `dist` directory.
*   **`npm run start`**: Starts the compiled Node.js server.
*   **`npm run dev`**: Runs the development server with `nodemon`/`ts-node`.
*   **`npm run db:generate`**: Generates Drizzle ORM migrations.
*   **`npm run db:migrate`**: Applies Drizzle ORM migrations.
*   **`npm test`**: Runs unit and integration tests using Vitest.
*   **`npm run test:ui`**: Runs tests with Vitest UI.
*   **`stripe listen --forward-to localhost:4242/webhooks/stripe`**: Listens for Stripe webhooks locally. (Also aliased as `npm run stripe:listen` in `package.json`).
*   **`scripts/db-url-field.mjs`**: A utility script to extract components of `DATABASE_URL`.
