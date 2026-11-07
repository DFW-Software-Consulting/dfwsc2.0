# DFWSC Frontend

React + Vite application for the DFW Software Consulting marketing site, client onboarding and payment return pages, and the admin dashboard.

## Tech Stack

- React 18 with React Router 7 (imports still come from `react-router-dom`)
- Vite 8, TailwindCSS v4, TanStack Query v5
- three.js for the Home and Team scenes only (lazy-loaded)
- Vitest 5 for tests

Architecture, data fetching, theming, prerendering and SEO are documented in [docs/FRONTEND.md](../docs/FRONTEND.md); tokens and UI rules in [docs/STYLES.md](../docs/STYLES.md).

## Development

### Docker dev stack (recommended)

From the repository root:

```bash
cp .env.example .env
make up-build
```

The `web` service runs the Vite dev server on `http://localhost:5173` against the containerized API on `http://localhost:4242`. Details are in the root [README.md](../README.md).

### Without Docker

```bash
npm install
npm run dev     # http://localhost:5173
```

Set `VITE_API_URL=http://localhost:4242/api/v1` in the root `.env` so the dev server reaches a locally running API.

### Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build to `build-dist/`, followed by a prerender step (`scripts/prerender.mjs`) |
| `npm run preview` | Preview the production build |
| `npm test` | Vitest |
| `npm run lint` | ESLint (react-hooks rules) and Biome |

## Routes

Defined in `src/routes.js`.

| Route | Page |
|-------|------|
| `/`, `/pricing`, `/team`, `/privacy` | Marketing pages, prerendered at build time |
| `/demos` | Unlisted sample-sites page |
| `/onboard#token=<token>` | Client Stripe onboarding (token entry) |
| `/admin` | Admin dashboard |
| `/payment-success`, `/payment-cancel` | Checkout return pages |
| `/onboarding-success` | Return page after Stripe onboarding |
| `/regenerate-key`, `/request-key-regeneration` | API key regeneration |
| any other path | 404 page |

The prerendered marketing pages are indexable. All other routes are served from an unrendered shell (`spa.html`) with `noindex`. `/docs` is not a React route: nginx redirects it (301) to the developer guide on Nextcloud.

## Admin dashboard

Open `/admin` and sign in with your Nextcloud account. The account must be in one of the groups in `ADMIN_NEXTCLOUD_GROUPS`; accounts with two-factor login need a Nextcloud app password.

From the dashboard you can manage clients and groups, create accounts, send onboarding emails, and view payment reports. See [docs/FRONTEND.md section 6](../docs/FRONTEND.md#6-admin-dashboard).

## Environment and build

- Vite reads the **repository-root** `.env` (`envDir: '../'` in `vite.config.js`); there is no `front/.env.example`.
- `VITE_API_URL` is the API base. It defaults to `/api/v1` in the Docker build, where nginx proxies `/api/` to the API.
- `VITE_ANALYTICS_SRC` and `VITE_ANALYTICS_DOMAIN` are optional.
- The `Dockerfile` takes `VITE_API_URL`, `VITE_ANALYTICS_SRC` and `VITE_ANALYTICS_DOMAIN` as build arguments, builds with Vite, checks that the prerendered pages exist, and serves `build-dist/` from nginx with `nginx.conf`.

The API variables and feature flags are in [docs/ENVIRONMENT.md](../docs/ENVIRONMENT.md).
