# Frontend Architecture

This document details the frontend implementation, state management, and UI patterns for the DFWSC Payment Portal.

## 1. Tech Stack
- **Framework**: React 18
- **Build Tool**: Vite
- **Routing**: React Router 6
- **State & Data Fetching**: TanStack Query v5
- **Styling**: TailwindCSS v4

## 2. Directory Structure (`front/src/`)
- **`api/`**: API client wrappers per domain (`auth`, `clients`, `groups`, `onboarding`, `payments`, `settings`), plus `client.js` as the shared fetch wrapper.
- **`components/`**: UI components organized by domain:
  - **`admin/`**: Dashboard components (ClientList, EditClientModal, GroupPanel, PaymentReports, SettingsPanel, etc.).
  - **`admin/shared/`**: Reusable admin primitives (AdminTable, BaseModal, Button, FormInput, StatusBadge, etc.).
  - **Marketing components**: Banner, CaseStudies, Contact, Footer, Hero, Navbar, Process, Services, TechStrip, ValueProps, Values.
- **`contexts/`**: `AuthContext` (admin JWT state), `ThemeContext` (light/dark toggle).
- **`hooks/`**: TanStack Query hooks — `useClients`, `useGroups`, `useOnboarding`, `usePaymentReports`, `useSettings`, `useSetupStatus`.
- **`pages/`**: Route-level components.
- **`utils/`**: `scrollToSection`, `validation`, `logger`.

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

## 4. Data Fetching
TanStack Query manages all server state. API logic lives in `src/api/`; hooks in `src/hooks/` compose queries/mutations on top. Components never call `fetch` directly.

## 5. Theme System
The app supports light and dark modes via `ThemeContext`. The active mode applies a `.dark` class on the root element, toggling CSS custom properties defined in `index.css`:
- **Light**: white backgrounds, slate-900 text.
- **Dark**: slate-950 backgrounds, slate-50 text.

Glassmorphism surfaces use the `.glass` and `.glass-dark` utility classes.

## 6. Admin Dashboard
`AdminPage` is a thin wrapper around `AdminDashboard`, which is login-gated via `AuthContext` — it renders `AdminLogin` (or `AdminSetup` on first run) until authenticated, then the dashboard tabs, which include:
- **ClientList**: tabular client management with edit, resend-onboarding-link, and activate/deactivate actions.
- **GroupPanel**: group creation and management.
- **PaymentReports**: Stripe PaymentIntent history per client or group.
- **SettingsPanel**: system settings (company name, contact email, default processing fee in cents or percent).
- **AddClientModal**: create a new client (name, email, phone).
