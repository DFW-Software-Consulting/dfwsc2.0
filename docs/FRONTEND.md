# Frontend Architecture

This document details the frontend implementation, state management, and UI patterns for the DFWSC Payment Portal.

## 1. Tech Stack
- **Framework**: React 18
- **Build Tool**: Vite 8 (`vite build`, plus a prerender step; see section 7)
- **Routing**: React Router 7 (`react-router-dom`)
- **State & Data Fetching**: TanStack Query v5
- **Styling**: TailwindCSS v4
- **Motion**: `motion` (Framer Motion, `LazyMotion` + `m.*`), marketing pages only, via `components/motion/Reveal.jsx`
- **Smooth scroll**: `lenis`, marketing pages only (mounted by `MotionRoot`; see STYLES.md), registered in `utils/smoothScroll.js` for `scrollToSection`
- **3D**: `three`, imported only by `components/HeroScene.jsx` (Home hero), `components/TeamScene.jsx` (Team hero) and their shared helper `components/sceneStage.js`. `HeroBackdrop` loads a scene with a dynamic `import()` (`loadNodes` is the default `load`, used by Home; Team passes `load={loadTerrain}`), so each scene is its own lazy chunk, and only on wide, motion-allowed, WebGL-capable screens. The entry chunk, Pricing (its hero art is plain SVG + CSS), the portal pages and admin never load `three`. Gating rules are in [STYLES.md](./STYLES.md).
- **Tests**: Vitest 5 with jsdom and Testing Library (see section 9)

## 2. Directory Structure (`front/src/`)
- **`api/`**: API client wrappers per domain (`apiKey`, `auth`, `clients`, `contact`, `groups`, `onboarding`, `payments`, `settings`), built on the shared `client.js` base wrapper (`apiFetch`, section 4).
- **`components/`**: UI components organized by domain:
  - **`admin/`**: Dashboard components (`AdminDashboard`, `AdminLogin`, `ClientList`, `ClientProfileView`, `AddClientModal`, `EditClientModal`, `GroupPanel`, `PaymentReports`, `SettingsPanel`, `ConfirmModal`, `Toast`).
  - **`admin/shared/`**: Reusable admin primitives (`AdminTable`, `AdminCard`, `BaseModal`, `Button`, `FormInput`, `StatusBadge`, `FeeConfigSection`, `RowActions`, `ErrorMessage`, `LoadingSpinner`, `TruncationNotice`, `onboardingState`, `useMinWidth`, `useModalLayer`).
  - **`motion/`**: `Reveal.jsx` (`MotionRoot`, `Reveal`, `RevealGroup`, `RevealItem`, `MaskLine`, `Swap`), `SmoothScroll.jsx` (Lenis), `ScrollFx.jsx` (scroll-linked helpers), `HeroHeading`, `SectionHeading`, `useMotionAllowed`, `useTilt`. Marketing pages only.
  - **Hero backgrounds** (directly in `components/`): `HeroBackdrop` (static fallback and gating), `HeroScene` (Home three.js scene), `TeamScene` (Team three.js scene), `sceneStage.js` (shared renderer setup), `PricingHeroArt` (Pricing SVG art, no three.js), `PageHero`.
  - **App shell and shared sections**: `Navbar`, `Footer`, `Logo`, `ErrorBoundary`, `Contact`, `CtaStrip`, `Disclosure`.
  - **App utilities**: `Analytics` conditionally loads a Plausible-compatible script when `VITE_ANALYTICS_SRC` is configured; it is a no-op otherwise. `VITE_ANALYTICS_DOMAIN` optionally sets the tracked domain. `RouteTracker` records visit context (section 4).
- **`contexts/`**: `AuthContext` (admin JWT state), `ThemeContext` (light/dark toggle).
- **`hooks/`**: TanStack Query hooks (`useClients`, `useContact`, `useGroups`, `useOnboarding`, `usePaymentReports`, `useSettings`, `useApiKey`) plus UI hooks such as `usePageTitle`.
- **`pages/`**: Route-level components. The marketing pages (`Home`, `Pricing`, `Team`) and `Demos` and `NotFound` each import a co-located stylesheet (`Home.css`, `Pricing.css`, `Team.css`, `Demos.css`, `NotFound.css`).
- **`content/`**: Data the pages render and the build reuses for JSON-LD: `pricing.js` (hosting plans, retainer, FAQ), `team.js` (team members), `demos.js` (sample sites for `/demos`; add an entry to add a card, preview images are in `assets/demos/`).
- **`seo/`**: `meta.js` (per-route metadata), `head.js` and `render.js` (head tags), `Seo.jsx` (client head manager), `jsonld.js` (structured data, build time).
- **`styles/`**: `studio.css`, shared primitives for the marketing pages (see [STYLES.md](./STYLES.md)).
- **`utils/`**: `scrollToSection`, `smoothScroll`, `validation`, `logger`, `lazyPage`, `preloadRecovery`, `useIsClient`, `viewTransition`, `useTransitionedLocation`, `visitContext`.
- **`test/`**: Test setup (`setup.js`) and `renderWithProviders.jsx`. Tests live in `__tests__/` (and `__tests__/api/`).
- **`front/public/`**: Static files served as-is: `theme-init.js`, `robots.txt`, `llms.txt`, icons and logo images.
- **`front/scripts/`**: Build-time scripts: `prerender.mjs`, `page-assets.mjs`, `verify-build.mjs` (section 7).

## 3. Routes (`routes.js`, rendered by `App.jsx`)
| Path | Component | Description |
|------|-----------|-------------|
| `/` | `Home` | Marketing landing page |
| `/pricing` | `Pricing` | Pricing tiers |
| `/team` | `Team` | Team members |
| `/privacy` | `Privacy` | Privacy policy (prerendered, indexable) |
| `/demos` | `Demos` | Sample-sites page for prospects. Nothing in the app links to it; it is a private route (noindex, `spa.html`, not in the sitemap). Cards come from `content/demos.js` |
| `/onboard` | `OnboardClient` | Token-based client onboarding |
| `/admin` | `AdminPage` | Admin dashboard (login-gated; Nextcloud sign-in) |
| `/payment-success` | `PaymentSuccess` | Post-payment success screen |
| `/payment-cancel` | `PaymentCancel` | Payment cancelled screen |
| `/onboarding-success` | `OnboardingSuccess` | Post-Stripe-onboarding screen |
| `/regenerate-key` | `RegenerateApiKey` | Token-based API key regeneration |
| `/request-key-regeneration` | `RequestApiKeyRegeneration` | Request a key regeneration email |
| `*` | `NotFound` | Fallback for unknown routes (nginx serves `404.html` with a real 404 status) |

`/docs`, `/docs/` and `/docs.html` are not routes: nginx answers them with a 301 to the Nextcloud developer guide (section 7). Marketing-to-marketing navigations (`/`, `/pricing`, `/team`, `/privacy`, `/demos`) cross-fade through the View Transitions API (section 5); other routes swap plainly.

## 4. Data Fetching
TanStack Query manages all server state. API logic lives in `src/api/`; hooks in `src/hooks/` compose queries/mutations on top. Components never call `fetch` directly.

`src/api/client.js` exports `apiFetch(path, { token, method, body, headers, timeoutMs, signal })`:
- The URL is `import.meta.env.VITE_API_URL` + `path` (section 8 covers how that value is set).
- Sends `Content-Type: application/json`, plus `Authorization: Bearer <token>` when a token is passed. JSON bodies are stringified.
- Times out after 15 seconds (`DEFAULT_TIMEOUT_MS`) and then throws `Error("Request timed out. Please try again.")`.
- Non-2xx responses throw an `Error` whose message is `data.error` (or `HTTP <status>`), with `status` and `data` attached. A non-JSON error body becomes `{ error: <first 200 chars> }`.

The `QueryClient` in `main.jsx` uses `retry: 1`, `staleTime: 30s` and `refetchOnWindowFocus: false`. Its `QueryCache` `onError` calls `AuthContext`'s `logout` (through `authLogoutRef`) on any query error with `status === 401`, so an expired admin token returns the user to the login form. The logout also clears the query cache.

The `components/Contact.jsx` form (rendered in the Home contact band, split layout, styled by the `.studio-contact-*` / `.studio-field` classes) submits through `api/contact.js` and `useContactForm`. Name, email, company, and message limits mirror the public backend endpoint; name, company and message are required, company is limited to 100 characters.

Visit context for that form lives in `front/src/utils/visitContext.js`, populated by `RouteTracker`. It is in-memory only and records just allowlisted public routes (`/`, `/pricing`, `/team`, `/privacy`) plus UTM values, the landing path and external referrer host; it writes no cookies or storage. It is sent as `context` on `POST /api/v1/contact`, and the `/privacy` page describes this to visitors.

## 5. Theme System
The app supports light and dark modes via `ThemeContext`. It defaults to the system preference, persists the choice in `localStorage` (key `theme`) once the visitor toggles it, and applies a `.light` or `.dark` class on `<html>`, which switches the CSS custom properties defined in `index.css`:
- **Light**: paper page (`#f8f7f3`), navy ink text (`#0f1e33`).
- **Dark**: navy page (`#0b1322`), off-white text (`#eef2f8`).
- Brand blue is `#2c6daf` (logo), used for the primary button; sand/bronze is the accent. Full token table: [STYLES.md](./STYLES.md).

The prerendered HTML is theme-neutral, so `public/theme-init.js` (a blocking external script in `<head>`; the CSP forbids inline scripts) sets the class from `localStorage.theme`, falling back to `prefers-color-scheme`, before first paint. `ThemeProvider` applies the same rule (`readTheme`, tolerant of blocked storage). While hydrating it renders a "light" placeholder so the markup matches the prerender, does not touch the `<html>` class, then switches to the real theme in a transition. Keep `theme-init.js` and `readTheme` in step. nginx sends `theme-init.js` with `Cache-Control: no-cache` for the same reason.

Heroes follow the theme (paper with a blue glow in light, navy in dark). Only the inverse bands (the contact band and the featured pricing card) stay navy in both themes. Use the semantic tokens and utilities documented in [STYLES.md](./STYLES.md) rather than raw Tailwind grays.

### View transitions
`utils/viewTransition.js` (`runViewTransition(update, { className, origin })`) is the single wrapper for the View Transitions API. It runs `update` plainly when the API is missing or `prefers-reduced-motion: reduce` is set, so the instant swap is the fallback. Otherwise it adds `className` to `<html>` for the length of the transition so the matching rules in `index.css` apply. Two users:
- **Theme toggle** (`ThemeContext.toggleTheme`, class `theme-vt`): the new theme grows as a circle from the clicked button.
- **Route change** (`utils/useTransitionedLocation.js`, class `route-vt`): on a marketing-to-marketing navigation the old page stays up until the new page's chunk has loaded (at most 1.5 s), then `<main>` cross-fades. Other routes (admin, onboarding, payment pages) swap immediately.

CSS for both is documented in [STYLES.md](./STYLES.md).

## 6. Admin Dashboard
`AdminPage` (route `/admin`) is self-contained and login-gated via `AuthContext`. Unauthenticated visitors see `AdminLogin` ("Sign in with your Nextcloud account", with a note that accounts with two-factor login need a Nextcloud app password); it posts to `POST /auth/login` and shows the API's message for 401 (wrong credentials), 403 (account not in an allowed Nextcloud group) and 503 (Nextcloud unavailable). The JWT is kept in memory only (no storage), so a page reload logs out. A 401 on any later query logs out automatically (section 4). There is no first-run setup or bootstrap screen. On successful login it renders `AdminDashboard`, a "Welcome, Admin!" header with a Logout button and four tabs (the tab strip scrolls sideways on narrow screens). All tabs query the `client_portal` workspace:

| Tab | Component | What it does |
|-----|-----------|--------------|
| Accounts | `ClientList` (+ `AddClientModal`, `EditClientModal`, `ClientProfileView`) | Client table with edit, delete, active toggle, resend onboarding, and API key regeneration email (`POST /api-key/regenerate-request/admin`). The "Add Client" button opens `AddClientModal`. |
| Companies | `GroupPanel` | Create and manage groups. |
| Reports | `PaymentReports` | Payment report (`GET /reports/payments`) for a client, a group or all clients, with a row limit; runs on demand. |
| Settings | `SettingsPanel` | Edits four settings, each saved on its own through `PATCH /settings/:key`: `default_fee_cents`, `default_fee_percent`, `company_name`, `contact_email`. |

## 7. SEO, head tags and prerendering
- **One source of truth:** `src/seo/meta.js` holds the title, description and `indexable` flag per route (plus the not-found and SPA-shell metadata). `src/seo/head.js` turns it into the managed head tags; `<Seo />` (mounted in `App`) applies them on every navigation, and the prerender writes the same tags into the HTML. Private routes and unknown paths get `robots: noindex,nofollow`; indexable routes get a canonical (`https://dfwsc.com`, no trailing slash) and og/twitter URLs. Add a new public page by adding it to `PUBLIC_ROUTES` and `routes.js`; a test checks the route table, `meta.js` and `nginx.conf` agree. Private routes (the portal pages, `/admin`, `/demos`) are listed in `PRIVATE_ROUTES` and served from `spa.html` with `X-Robots-Tag: noindex, nofollow`.
- **Dynamic titles:** the two status pages whose title depends on state (`PaymentSuccess`, `OnboardingSuccess`) still call `usePageTitle(title)` after `<Seo />` has set the route default.
- **Prerender:** `npm run build` (plain `vite build`) runs the client build, then a plugin in `vite.config.js` (skipped if the client build failed) bundles `src/entry-server.jsx` for Node (`build-ssr/`) and calls `scripts/prerender.mjs`, which writes `index.html`, `pricing.html`, `team.html`, `privacy.html`, `404.html`, an unrendered `spa.html` (portal routes) and `sitemap.xml` into `build-dist/`, then runs `scripts/verify-build.mjs` (also run by the Dockerfile as a separate step). The check fails the build unless every public page, `spa.html`, `404.html` and `sitemap.xml` exist, and each public page contains an `<h1`, a canonical link and at least two stylesheet links (the entry CSS plus the page's own chunk CSS). Each prerendered page also links its lazy chunk's CSS and a `modulepreload` for its JS, taken from the Vite build manifest by `scripts/page-assets.mjs`, so the first paint is styled; a page missing from the manifest fails the build.
- **JSON-LD:** `src/seo/jsonld.js` (build time only, written by the prerender) emits one `@graph` per public page, built from the same data the pages render (`src/content/`). Every page gets a `ProfessionalService` (organization) and a `WebSite` node. `/pricing` adds an `OfferCatalog` of hosting-plan `Offer`/`Service` nodes with `UnitPriceSpecification` and a `FAQPage`; `/team` adds a `Person` node per team member (`worksFor` the organization).
- **Hydration:** `main.jsx` calls `hydrateRoot` when `#root` has children (after preloading the matched route chunk) and `createRoot` otherwise. Anything that depends on the browser (stored theme, clock, motion preferences) must render the server value first: see `useIsClient`, `useMotionAllowed` and `ThemeProvider`'s `hydrating` prop. Reveal animations switch on after hydration, but elements already in the viewport (and `mount` reveals) stay in their final state; only content below the fold animates on scroll.
- **Developer docs:** there is no docs page in the site. The developer integration guide lives in Nextcloud (Collective "Developer Integration Guide", access via the `integrators` group); nginx 301-redirects `/docs`, `/docs/` and `/docs.html` to it.
- **Stale-asset recovery:** after a deploy, a hashed chunk a stale tab asks for may 404. Two layers handle it. `public/theme-init.js` (unhashed, always revalidated) listens for failed `<script>`/`<link>` loads under `/assets/` (it matters most when the main bundle fails, because no app code runs then) and re-fetches the file with `cache: "reload"` and reloads once. In the app, `utils/preloadRecovery.js` does the same for `vite:preloadError` and lazy-chunk errors. Both share one guard (`sessionStorage` key `preload-reloaded-at`, 30 s window) so a persistent failure shows the real error instead of looping. nginx cooperates: a missing `/assets/` file returns a plain-text 404 (never `index.html`) with `Cache-Control: no-store`, and only successful asset responses are `immutable`.
- **CSP and analytics:** the CSP is set by nginx (`front/nginx.conf`). The Docker build derives the analytics origin from the `VITE_ANALYTICS_SRC` build arg and substitutes it for `__ANALYTICS_ORIGIN__` in `script-src` and `connect-src`; with analytics off those directives stay restricted to `'self'` (and `https://api.dfwsc.com` for `connect-src`). Changing the analytics URL therefore needs a rebuild of the frontend image.
- **nginx:** serves the prerendered files at clean URLs (`/pricing/` redirects to `/pricing`), portal routes as `spa.html` with `X-Robots-Tag: noindex, nofollow`, and real 404s for everything else. Static `robots.txt`, `llms.txt`, icons live in `front/public/`.

## 8. Page Titles
Status pages whose title depends on their state pass it to `usePageTitle(title)`, which applies the shared `<page> - DFW Software Consulting` convention. All other routes get their title from `src/seo/meta.js`.

## 9. Testing
Vitest 5 with jsdom (`front/vitest.config.js`; setup in `src/test/setup.js`, `globals: true`, `css: true`). Tests are in `front/src/__tests__/` and `__tests__/api/`; render helpers are in `src/test/renderWithProviders.jsx`.

| Command | Where | What |
|---------|-------|------|
| `make test-front` / `npm run test:front` | repo root | Runs the frontend suite locally |
| `npm test` (`vitest`, watch mode) | `front/` | Same suite, interactive |
| `npm run lint` | `front/` | `eslint src && biome check src` |

Several tests are guards that fail when a convention is broken: `adminButton.test.jsx` (no color utilities passed to the admin `Button`), `seoMeta.test.js` (route table, `meta.js` and `nginx.conf` agree), `verifyBuild.test.js` and `pageAssets.test.js` (build checks), `dockerfile.test.js` (Dockerfile build args and CSP substitution), `themeInit.test.js` (`theme-init.js` matches `readTheme`), `preloadRecovery.test.js`, `sceneStage.test.js`, `viewTransition.test.jsx` and `useTransitionedLocation.test.jsx`. The backend suite is separate (see [DEVELOPMENT.md](./DEVELOPMENT.md)).

## 10. Build and Environment
- **Build:** `npm run build` in `front/` is `vite build`; output goes to `front/build-dist/` (also `build-ssr/`, the temporary server bundle for prerendering). Node 22.12 or newer is required (`engines`).
- **Env files:** `vite.config.js` sets `envDir: '../'`, so Vite reads the repo-root `.env`, not `front/.env`. Only `VITE_`-prefixed variables reach the browser bundle. Variable list: [ENVIRONMENT.md](./ENVIRONMENT.md).
- **Variables:** `VITE_API_URL` (API base, includes `/api/v1`; the `Dockerfile` default is `/api/v1`, `.env.example` uses `http://localhost:4242/api/v1` for local dev), `VITE_ANALYTICS_SRC` and `VITE_ANALYTICS_DOMAIN` (optional analytics). They are inlined at build time, so the Docker image takes them as build args (`ARG`/`ENV` in `front/Dockerfile`); changing one means rebuilding the image.
- **Dev server:** `make up` runs the `web` service from `docker-compose.dev.yml` (Vite on port 5173, `./front` mounted). `make dev-frontend` runs `npm run dev --prefix front` outside Docker.
- **Production image:** multi-stage build (Node 22 builder, `nginx:alpine`). nginx runs as the non-root `nginx` user with its pid file in `/tmp`, listens on port 80, serves the static build and proxies `/api/` to `http://dfwsc-api:4242`. Deployment topology: [COOLIFY_DEPLOYMENT.md](./COOLIFY_DEPLOYMENT.md).
