# Frontend Architecture

This document details the frontend implementation, state management, and UI patterns for the DFWSC Payment Portal.

## 1. Tech Stack
- **Framework**: React 18
- **Build Tool**: Vite
- **Routing**: React Router 6
- **State & Data Fetching**: TanStack Query v5
- **Styling**: TailwindCSS v4

## 2. Directory Structure (`front/src/`)
- **`api/`**: API client wrappers per domain (`auth`, `clients`, `groups`, `onboarding`, `payments`, `settings`), built on the shared `client.js` base wrapper.
- **`components/`**: UI components organized by domain:
  - **`admin/`**: Dashboard components (ClientList, EditClientModal, GroupPanel, PaymentReports, SettingsPanel, etc.).
  - **`admin/shared/`**: Reusable admin primitives (AdminTable, BaseModal, Button, FormInput, StatusBadge, etc.).
  - **App shell**: `Navbar`, `Footer`, `ErrorBoundary`. Marketing page sections live inside their page components (`Home`, `Pricing`, `Team`).
- **`contexts/`**: `AuthContext` (admin JWT state), `ThemeContext` (light/dark toggle).
- **`hooks/`**: TanStack Query hooks — `useClients`, `useGroups`, `useOnboarding`, `usePaymentReports`, `useSettings`, `useSetupStatus`.
- **`pages/`**: Route-level components. The marketing pages (`Home`, `Pricing`, `Team`) each import a co-located stylesheet (`Home.css`, `Pricing.css`, `Team.css`).
- **`styles/`**: `studio.css`, shared primitives for the marketing pages (see [STYLES.md](./STYLES.md)).
- **`utils/`**: `scrollToSection`, `validation`, `logger`, `lazyPage`, `preloadRecovery`.

## 3. Routes (`App.jsx`)
| Path | Component | Description |
|------|-----------|-------------|
| `/` | `Home` | Marketing landing page |
| `/pricing` | `Pricing` | Pricing tiers |
| `/team` | `Team` | Team members |
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

## 5. Theme System
The app supports light and dark modes via `ThemeContext`. It defaults to the system preference, persists the choice in `localStorage`, and applies a `.light` or `.dark` class on `<html>`, which switches the CSS custom properties defined in `index.css`:
- **Light**: warm off-white page (`#f7f7f0`), deep teal-ink text.
- **Dark**: near-black teal page (`#0a1920`), off-white text.

Hero and contact bands stay dark in both themes. Use the semantic tokens and utilities documented in [STYLES.md](./STYLES.md) rather than raw Tailwind grays.

## 6. Admin Dashboard
`AdminPage` is self-contained and login-gated via `AuthContext`. It renders `AdminDashboard` on successful login, which includes:
- **ClientList**: tabular client management with edit, onboard, and filter actions.
- **GroupPanel**: group creation and management.
- **PaymentReports**: Stripe PaymentIntent history per client or group.
- **SettingsPanel**: system settings (company name, default payment terms).
- **AddClientModal**: surfaced via an "Add Client" button; creates a new client account in the portal.
