# Frontend Architecture

This document details the frontend implementation, state management, and UI patterns for the DFWSC Payment Portal.

## 1. Tech Stack
- **Framework**: React 18
- **Build Tool**: Vite
- **Routing**: React Router 6
- **State & Data Fetching**: TanStack Query v5
- **Styling**: TailwindCSS v4
- **Motion**: `motion` (Framer Motion, `LazyMotion` + `m.*`), marketing pages only, via `components/motion/Reveal.jsx`
- **Smooth scroll**: `lenis`, marketing pages only (mounted by `MotionRoot`; see STYLES.md), registered in `utils/smoothScroll.js` for `scrollToSection`
- **3D**: `three`, used only by `components/HeroScene.jsx`. It is loaded with a dynamic `import()` from `HeroBackdrop`, so it lives in its own lazy chunk (~133 kB gzip) that the entry, Pricing and Team chunks never load, and only on wide, motion-allowed, WebGL-capable screens

## 2. Directory Structure (`front/src/`)
- **`api/`**: API client wrappers per domain (`auth`, `clients`, `contact`, `groups`, `onboarding`, `payments`, `settings`), built on the shared `client.js` base wrapper.
- **`components/`**: UI components organized by domain:
  - **`admin/`**: Dashboard components (ClientList, EditClientModal, GroupPanel, PaymentReports, SettingsPanel, etc.).
  - **`admin/shared/`**: Reusable admin primitives (AdminTable, BaseModal, Button, FormInput, StatusBadge, etc.).
  - **`motion/`**: `Reveal` helpers (`MotionRoot`, `Reveal`, `RevealGroup`, `RevealItem`, `Swap`), `SmoothScroll` (Lenis) and `ScrollFx` (scroll-linked helpers) for the marketing pages; `HeroBackdrop` (static fallback + gating) and `HeroScene` (three.js, lazy) serve the Home hero.
  - **App shell**: `Navbar`, `Footer`, `ErrorBoundary`. Marketing page sections live inside their page components (`Home`, `Pricing`, `Team`).
  - **App utilities**: `Analytics` conditionally loads a Plausible-compatible script when `VITE_ANALYTICS_SRC` is configured; it is a no-op otherwise. `VITE_ANALYTICS_DOMAIN` optionally sets the tracked domain.
- **`contexts/`**: `AuthContext` (admin JWT state), `ThemeContext` (light/dark toggle).
- **`hooks/`**: TanStack Query hooks — `useClients`, `useContact`, `useGroups`, `useOnboarding`, `usePaymentReports`, `useSettings` — plus UI hooks such as `usePageTitle`.
- **`pages/`**: Route-level components. The marketing pages (`Home`, `Pricing`, `Team`) each import a co-located stylesheet (`Home.css`, `Pricing.css`, `Team.css`).
- **`styles/`**: `studio.css`, shared primitives for the marketing pages (see [STYLES.md](./STYLES.md)).
- **`utils/`**: `scrollToSection`, `validation`, `logger`, `lazyPage`, `preloadRecovery`.

## 3. Routes (`routes.js`, rendered by `App.jsx`)
| Path | Component | Description |
|------|-----------|-------------|
| `/` | `Home` | Marketing landing page |
| `/pricing` | `Pricing` | Pricing tiers |
| `/team` | `Team` | Team members |
| `/privacy` | `Privacy` | Privacy policy (prerendered, indexable) |
| `/docs` | `Docs` | API documentation page |
| `/onboard` | `OnboardClient` | Token-based client onboarding |
| `/admin` | `AdminPage` | Admin dashboard (login-gated) |
| `/payment-success` | `PaymentSuccess` | Post-payment success screen |
| `/payment-cancel` | `PaymentCancel` | Payment cancelled screen |
| `/onboarding-success` | `OnboardingSuccess` | Post-Stripe-onboarding screen |
| `/regenerate-key` | `RegenerateApiKey` | Token-based API key regeneration |
| `/request-key-regeneration` | `RequestApiKeyRegeneration` | Request a key regeneration email |
| `*` | `NotFound` | Fallback for unknown routes |

## 4. Data Fetching
TanStack Query manages all server state. API logic lives in `src/api/`; hooks in `src/hooks/` compose queries/mutations on top. Components never call `fetch` directly.

The `components/Contact.jsx` form (rendered in the Home contact band, split layout, styled by the `.studio-contact-*` / `.studio-field` classes) submits through `api/contact.js` and `useContactForm`. Name, email, company, and message limits mirror the public backend endpoint; name, company and message are required, company is limited to 100 characters.

Visit context for that form lives in `front/src/utils/visitContext.js`, populated by `RouteTracker`. It is in-memory only and records just allowlisted public routes (`/`, `/pricing`, `/team`, `/privacy`) plus UTM values, the landing path and external referrer host; it writes no cookies or storage. It is sent as `context` on `POST /api/v1/contact`, and the `/privacy` page describes this to visitors.

## 5. Theme System
The app supports light and dark modes via `ThemeContext`. It defaults to the system preference, persists the choice in `localStorage` once the visitor toggles it, and applies a `.light` or `.dark` class on `<html>`, which switches the CSS custom properties defined in `index.css`:
- **Light**: warm off-white page (`#f7f7f0`), deep teal-ink text.
- **Dark**: near-black teal page (`#0a1920`), off-white text.

The prerendered HTML is theme-neutral, so `public/theme-init.js` (a blocking external script in `<head>`; the CSP forbids inline scripts) sets the class from `localStorage.theme`, falling back to `prefers-color-scheme`, before first paint. `ThemeProvider` applies the same rule (`readTheme`, tolerant of blocked storage). While hydrating it renders a "light" placeholder so the markup matches the prerender, does not touch the `<html>` class, then switches to the real theme in a transition. Keep `theme-init.js` and `readTheme` in step.

Hero and contact bands stay dark in both themes. Use the semantic tokens and utilities documented in [STYLES.md](./STYLES.md) rather than raw Tailwind grays.

## 6. Admin Dashboard
`AdminPage` is self-contained and login-gated via `AuthContext`. Unauthenticated visitors see `AdminLogin` ("Sign in with your Nextcloud account", with a note that accounts with two-factor login need a Nextcloud app password); it posts to `POST /auth/login` and shows the API's message for 401 (wrong credentials), 403 (account not in an allowed Nextcloud group) and 503 (Nextcloud unavailable). The JWT is kept in memory only (no storage). There is no first-run setup or bootstrap screen. On successful login it renders `AdminDashboard`, which includes:
- **ClientList**: tabular client management with edit, onboard, and filter actions.
- **GroupPanel**: group creation and management.
- **PaymentReports**: Stripe PaymentIntent history per client or group.
- **SettingsPanel**: system settings (company name, default payment terms).
- **AddClientModal**: surfaced via an "Add Client" button; creates a new client account in the portal.

## 7. SEO, head tags and prerendering
- **One source of truth:** `src/seo/meta.js` holds the title, description and `indexable` flag per route (plus the not-found and SPA-shell metadata). `src/seo/head.js` turns it into the managed head tags; `<Seo />` (mounted in `App`) applies them on every navigation, and the prerender writes the same tags into the HTML. Private routes and unknown paths get `robots: noindex,nofollow`; indexable routes get a canonical (`https://dfwsc.com`, no trailing slash) and og/twitter URLs. Add a new public page by adding it to `PUBLIC_ROUTES` and `routes.js`; a test checks the route table, `meta.js` and `nginx.conf` agree.
- **Dynamic titles:** the two status pages whose title depends on state (`PaymentSuccess`, `OnboardingSuccess`) still call `usePageTitle(title)` after `<Seo />` has set the route default.
- **Prerender:** `npm run build` (plain `vite build`) runs the client build, then a plugin in `vite.config.js` (skipped if the client build failed) bundles `src/entry-server.jsx` for Node (`build-ssr/`) and calls `scripts/prerender.mjs`, which writes `index.html`, `pricing.html`, `team.html`, `privacy.html`, `docs.html`, `404.html`, an unrendered `spa.html` (portal routes) and `sitemap.xml` into `build-dist/`, then checks they exist (`scripts/verify-build.mjs`, also run by the Dockerfile). JSON-LD (`src/seo/jsonld.js`, build time only) is built from the same data the pages render (`src/content/`).
- **Hydration:** `main.jsx` calls `hydrateRoot` when `#root` has children (after preloading the matched route chunk) and `createRoot` otherwise. Anything that depends on the browser (stored theme, clock, motion preferences) must render the server value first: see `useIsClient`, `useMotionAllowed` and `ThemeProvider`'s `hydrating` prop. Reveal animations switch on after hydration, but elements already in the viewport (and `mount` reveals) stay in their final state; only content below the fold animates on scroll.
- **nginx:** serves the prerendered files at clean URLs (`/pricing/` redirects to `/pricing`), portal routes as `spa.html` with `X-Robots-Tag: noindex, nofollow`, and real 404s for everything else. Static `robots.txt`, `llms.txt`, icons live in `front/public/`.

## 8. Page Titles
Status pages whose title depends on their state pass it to `usePageTitle(title)`, which applies the shared `<page> - DFW Software Consulting` convention. All other routes get their title from `src/seo/meta.js`.
