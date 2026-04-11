# Frontend Architecture

This document details the frontend implementation, state management, and UI patterns for the DFWSC Payment Portal.

## 1. Tech Stack
- **Framework**: React 18
- **Build Tool**: Vite
- **Routing**: React Router 6
- **State & Data Fetching**: TanStack Query v5
- **Styling**: TailwindCSS v4

## 2. Directory Structure (`front/src/`)
- **`api/`**: API client wrappers and domain-specific fetchers (auth, clients, payments, etc.).
- **`components/`**: UI components, organized by domain (e.g., `admin/`).
- **`pages/`**: Main route-level components (Home, Pricing, Team, Onboarding).
- **`utils/`**: Shared helper functions (scrolling, validation).

## 3. Data Fetching & Mutations
The project uses **TanStack Query (React Query)** to manage server state.
- **Queries**: Used for fetching client lists, invoice statuses, and dashboard metrics.
- **Mutations**: Used for onboarding initiation, payment creation, and admin actions.
- **Pattern**: API logic is isolated in `src/api/` and called via hooks in components.

## 4. Routing Logic
Defined in `App.jsx` using `react-router-dom`.
- **Public Routes**: `/`, `/pricing`, `/team`.
- **Onboarding**: `/onboard?token=...` (Token-based entry).
- **Admin**: Dashboard components located in `src/components/admin/`.

## 5. UI Design
Following a **Glassmorphism** aesthetic (blur effects, translucent overlays) and a dark-mode first design system (bg-slate-950). For more on styling, see [STYLES.md](./STYLES.md).
