# Styling & UI Patterns

This document describes the design system and styling conventions for the DFWSC Payment Portal frontend.

## 1. Tech Stack
- **Framework**: **TailwindCSS v4**.
- **Theming**: Configured via the `@theme` block in `front/src/index.css`.
- **Fonts**: `Inter` as the primary sans-serif font.

## 2. Design System

### Colors
- **Background**: `bg-slate-950` (Dark Navy/Black).
- **Brand Tokens**:
  - `brand-50` to `brand-500`.
  - Primary: `brand-500` (`#0b7285`).
  - Secondary: `brand-400` (`#2ca1b4`).

### Aesthetics
- **Glassmorphism**: High usage of `backdrop-blur-xl`, `bg-white/10` borders, and `bg-slate-950/80`.
- **Glows & Depth**: Custom shadows with `rgba(11, 114, 133, 0.6)`.

## 3. UI Patterns

### Reusable Components
- **Pill Buttons**: Rounded-full, border, transition effect.
- **Interactive States**: Hover scales (`hover:scale-105`), glow transitions.

### Styling Conventions
- **Utility-First**: Use Tailwind classes for most layouts, borders, and effects.
- **Component-Specific CSS**: Only for complex animations (e.g., `Banner.css` for the sliding text track).

## 4. Vertical Slicing
Components are grouped by feature (`front/src/components/admin`, `front/src/components/Hero.jsx`). Logic should be co-located with components where possible, utilizing TanStack Query for data fetching.
