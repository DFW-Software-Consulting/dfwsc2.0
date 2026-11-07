# Development Workflow

Local setup, tests, git hooks and CI for the portal. Environment variables are in [ENVIRONMENT.md](./ENVIRONMENT.md); deployment is in [COOLIFY_DEPLOYMENT.md](./COOLIFY_DEPLOYMENT.md).

Requirements: Node `>=22.12.0` (root, `backend` and `front` `package.json` `engines`), Docker with the Compose plugin.

## 1. Local dev stack

The dev stack is two compose files used together; `docker-compose.dev.yml` is an override and does not work alone. The Makefile wires them (`COMPOSE` in `Makefile`):

```sh
cp .env.example .env     # then edit
make up-build            # first run; later: make up
```

`.env.example` points `DATABASE_URL` at host `db`, which resolves only inside the stack.

| Service | Source | Port | Notes |
|---------|--------|------|-------|
| `api` | `node:22-alpine` with `./backend` mounted | 4242 | Runs `npm install`, waits for `db`, runs `drizzle-kit migrate`, then `npm run dev` (nodemon + ts-node). A failed migration is logged and the API still starts. |
| `web` | `node:22-alpine` with `./front` mounted | 5173 | Vite dev server. |
| `db` | `postgres:17` | 127.0.0.1:5432 | Volume `pgdata`. |
| `redis` | `redis:7-alpine` | 127.0.0.1:6379 | Used only if `REDIS_URL` is set in `.env`; otherwise rate limiting is in-memory. |
| `mailhog` | `mailhog/mailhog` | SMTP 1025, UI 8025 | The `.env.example` SMTP values point here. |
| `stripe-cli` | `stripe/stripe-cli` | - | Forwards Stripe events to `api:4242/api/v1/webhooks/stripe`; needs a real `STRIPE_SECRET_KEY` in `.env`. |
| `loki`, `promtail` | Grafana | 3100 | Log aggregation; configuration in `observability/`. Port 3100 can clash with another local Loki. |

The dev `api` container runs with `NODE_ENV=development`, so it applies migrations itself. Production never does: the `migrator` service runs `npm run db:migrate` once per deploy ([COOLIFY_DEPLOYMENT.md](./COOLIFY_DEPLOYMENT.md)). Swagger is forced off in the dev stack (see [ENVIRONMENT.md](./ENVIRONMENT.md) section 2).

### Without Docker

`backend/src/index.ts` loads the root `.env` (`../.env` relative to `backend/`) when `NODE_ENV` is not `production`. Point `DATABASE_URL` at a reachable Postgres (`localhost`, not `db`). `drizzle-kit` does not read `.env`; it requires `DATABASE_URL` to be exported in the shell (`backend/drizzle.config.ts`). Then `make dev-backend` and `make dev-frontend` (or `npm run dev:backend` / `npm run dev:frontend`). The frontend reads the root `.env` too (`envDir` in `front/vite.config.js`).

### Make targets

| Target | Does |
|--------|------|
| `make up` / `up-build` / `down` / `down-v` | Start (optionally build), stop, stop and delete volumes (destroys `pgdata`). |
| `make logs` / `ps` / `sh` | API logs, container list, shell in `api`. |
| `make dev-backend` / `dev-frontend` | Run the API or Vite on the host. |
| `make test` | `test-front` then `test-back`. |
| `make test-front` | Frontend tests on the host. |
| `make test-back` | Backend tests in the running `api` container. |
| `make test-up` | Start the stack, wait for vitest to be installed, run backend then frontend tests. |
| `make coverage` | Backend tests with coverage in the container (`npm run test:coverage`). |
| `make prod`, `prod-build`, `down-prod`, `logs-prod`, `sh-prod`, `ps-prod` | Run `docker-compose.prod.yml` locally (needs the external Docker network: `docker network create coolify`). The stack is `migrator`, `api`, `dfwsc-redis` and `backup`. |
| `make backup-build`, `backup-shell`, `backup-now`, `backup-list`, `backup-restore FILE=...` | Backup image helpers; see [BACKUP.md](./BACKUP.md). |

`make help` prints the list; its one-line stack descriptions are shorter than the tables above.

Other scripts: `npm run reset:test-data` and `reset:test-data:dry` (resets the local database and Stripe test-mode data; refuses a non-test Stripe key), `npm run db:generate` and `db:migrate` (root scripts that call the backend ones), `npm run lint`, `lint:fix`, `format` (Biome over `backend/src` and `front/src`).

## 2. Tests

| Suite | Command | Notes |
|-------|---------|-------|
| Backend | `make test-back` | Vitest, serial files (`fileParallelism: false`), 30 s timeouts. Needs a real Postgres through `DATABASE_URL`; the dev container supplies it. Root `npm test` refuses to run without `DATABASE_URL` (`test:back:guarded`). |
| Backend coverage | `make coverage` | Thresholds in `backend/vitest.config.ts`: statements 87, branches 79, functions 82, lines 87. This is the gate CI and the pre-push hook enforce. |
| Frontend | `make test-front` or `cd front && npm test` | Vitest with jsdom; setup in `front/src/test/setup.js`. Includes guard tests that read the Dockerfile and nginx config. |
| Frontend lint | `cd front && npx eslint src` | ESLint (react-hooks) plus Biome via `npm run lint`. |

Backend tests run with `NODE_ENV=test` and the values pinned in `vitest.config.ts`. Nextcloud and Stripe are replaced by fakes in `backend/src/__tests__/helpers/`; no test needs real Nextcloud or Stripe access. `smtp-mailhog.test.ts` sets its own SMTP values and does not need the MailHog container. MailHog (UI on port 8025) is only for viewing mail sent from the dev stack.

## 3. Git hooks (Husky)

`npm install` at the repository root runs `husky` (`prepare` script), which activates `.husky/`. The hooks:

### pre-commit

Runs these in order; the first failure stops the commit.

1. No commits on `main`.
2. No `.env` file staged (`.env.example` and `.env.test` allowed).
3. No merge conflict markers in staged changes.
4. No staged file over 500 KB.
5. A changed `package.json` must come with a staged `package-lock.json`.
6. `secretlint` on staged `ts, tsx, js, jsx, json, yaml, yml, sh, md` files.
7. A changed `backend/src/db/schema.ts` must come with a staged migration under `backend/drizzle/`. Skip: `SKIP_MIGRATION_CHECK=1`.
8. No `console.*` or `debugger` added to staged non-test source. Skip: `ALLOW_CONSOLE=1`.
9. No `.only` / `.skip` added to staged test files.
10. Warning only: a new `process.env.NAME` in staged code that has no `NAME=` line in `.env.example`.
11. `lint-staged`: Biome `check --write` on staged backend and frontend source (ESLint `--fix` also for frontend) and on staged Markdown.
12. Agent-doc mirrors in sync, compared against **`CLAUDE.md`** (section 4).
13. Backend type-check (`tsc --noEmit` for `tsconfig.build.json` and `tsconfig.json`) when backend TypeScript is staged. Skip: `SKIP_TYPECHECK=1`.

### commit-msg

`commitlint` with `commitlint.config.js`: Conventional Commits, types `feat fix docs style refactor chore test perf ci build revert`, header at most 100 characters, body lines at most 100 characters, no full stop, subject not start-case, pascal-case or upper-case.

### pre-push

1. Any push whose remote ref matches `refs/heads/main` is refused (the message says "force-pushing", but the check does not distinguish).
2. Backend coverage run inside the running dev `api` container (`docker compose ... exec -T api npm run test:coverage`). If the stack is not running the push fails with "Docker stack is not running". Skip: `SKIP_DOCKER_TESTS=1`. The step label says "90/80 coverage"; the real gate is the thresholds in `vitest.config.ts` (section 2).
3. `npm run lint` (Biome check).
4. Agent-doc mirrors in sync, compared against **`.claude/CLAUDE.md`** (section 4).
5. Backend type-check.
6. Frontend build (`npm run build:frontend`).
7. Frontend tests.
8. `docker compose -f docker-compose.prod.yml build`. Skip: `SKIP_DOCKER_BUILD=1`.

## 4. Agent instruction mirrors

Five files must stay byte-identical: `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `Qwen.md`, `Gemini.md`. They are tracked in git even though `.gitignore` lists `AGENTS.md`, `Qwen.md` and `Gemini.md`.

The checks use different bases, so a change to one file that is not copied to the others fails somewhere:

| Check | Base | Compared with |
|-------|------|---------------|
| pre-commit step 12 | `CLAUDE.md` | `AGENTS.md`, `Qwen.md`, `Gemini.md` |
| pre-push step 4 | `.claude/CLAUDE.md` | `AGENTS.md`, `Qwen.md`, `Gemini.md` |
| CI `docs-sync` | `CLAUDE.md` | `AGENTS.md`, `Qwen.md`, `Gemini.md` |

After editing any of them, edit `CLAUDE.md` and then run:

```sh
cp CLAUDE.md .claude/CLAUDE.md && cp CLAUDE.md AGENTS.md && cp CLAUDE.md Qwen.md && cp CLAUDE.md Gemini.md
```

## 5. CI (`.github/workflows/ci.yml`)

Runs on pull requests and on pushes to `main`; a newer run on the same ref cancels the older one.

| Job | What it checks |
|-----|----------------|
| `lint` | `npm run lint`, frontend ESLint, and `npm audit` for backend and frontend (non-blocking: ends in `|| true`). |
| `typecheck` | Backend `tsc --noEmit` for both tsconfigs, and the frontend build. |
| `test` | Postgres 17 service, `npm run db:migrate`, backend `test:coverage` (thresholds enforced), frontend tests. |
| `build` | After `lint`, `typecheck` and `test`: builds the backend, frontend and backup images. |
| `prod-compose-build` | `docker compose -f docker-compose.prod.yml config -q` and `build`, with dummy values. |
| `secrets` | `secretlint` over the whole repository. |
| `commitlint` | Pull requests only: lints every commit message in the PR range. |
| `source-guards` | Pull requests only: no added `console.*` / `debugger` in source and no added `.only` / `.skip` in tests. |
| `docs-sync` | `AGENTS.md`, `Qwen.md`, `Gemini.md` equal `CLAUDE.md`. |
| `fallow` | `fallow@2.104.0 dead-code` for `backend` and `front` against `fallow-baselines/*.json`; fails on new dead code, circular dependencies or unresolved imports beyond the baseline. To refresh a baseline after cleanup, run the command in the comment above the job with `--save-baseline`. |

`.github/workflows/opencode-review.yml` posts an automated review comment on non-draft same-repo pull requests. It is advisory: every step is `continue-on-error`, so it never fails a pull request. Dependabot (`.github/dependabot.yml`) opens monthly npm, Docker and compose update pull requests.

The pre-push hook runs the root `npm run lint` (Biome only), while CI also runs `npx eslint src` in `front/`. Run `cd front && npm run lint` before pushing frontend changes to catch ESLint failures locally.

## 6. Worktrees and other gotchas

- **Hooks do not run in a fresh worktree** until `npm install` has run at the root of that worktree (it creates the hook directory that `husky` points git at). Until then commits and pushes from the worktree skip every check above; CI is then the first gate. Install, then check that a commit with a bad message is rejected.
- **Install in each checkout.** `node_modules` in a long-lived checkout can lag `package.json`. Run `npm ci` at the root, in `backend/` and in `front/` before committing from a new worktree.
- **Pre-push needs the dev stack of the same directory.** The hook looks for a running `api` service with `docker compose` in the current directory, and Compose names a project after its directory, so the stack started in another checkout is not found. Start the stack from the worktree (`make up`), or push with `SKIP_DOCKER_TESTS=1` after running the tests another way.
- **A gitignored `backend/.env` changes test behavior.** `validateEnv()` calls `dotenv.config()` for any `NODE_ENV` other than `production`, including `test` (`backend/src/lib/env.ts:98-100`), and reads `.env` from the current directory. Variables that `vitest.config.ts` does not pin (for example `REDIS_URL`, `TRUST_PROXY`, `CLOUDFLARE_IP_RANGES`) leak into the run. In practice this has made the auth rate-limit tests fail; delete or rename `backend/.env` when they do. Use the root `.env` for local development.
- **`drizzle-kit` needs `DATABASE_URL` exported**, not just present in `.env`.
- **Large localhost cookies** can produce HTTP 431 from the dev servers; the dev stack raises the header limit through `NODE_OPTIONS`.
- **Migration timestamps.** Generate migrations with `npm run db:generate`; the pre-commit hook blocks a schema change without one. Production applies them through the `migrator` service; see [DATABASE.md](./DATABASE.md).
