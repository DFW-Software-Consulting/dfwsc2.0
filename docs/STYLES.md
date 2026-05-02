# Styling & UI Patterns

This document describes the design system and styling conventions for the DFWSC Payment Portal frontend.

## 1. Tech Stack
- **Framework**: TailwindCSS v4 (`@import "tailwindcss"` syntax, no `tailwind.config.js`).
- **Theming**: CSS custom properties in `front/src/index.css` — `@theme` block for design tokens, `:root` and `.dark` for runtime theme switching.
- **Font**: `Inter` (primary sans-serif).

## 2. Theme System
The app supports **light and dark modes** controlled by `ThemeContext`. Adding the `.dark` class to the root element activates dark mode variables.

### CSS Custom Properties
| Token | Light | Dark |
|-------|-------|------|
| `--bg-main` | `#ffffff` | `#020617` (slate-950) |
| `--bg-surface` | `#f1f5f9` (slate-100) | `#0f172a` (slate-900) |
| `--text-main` | `#0f172a` (slate-900) | `#f8fafc` (slate-50) |
| `--text-muted` | `#334155` (slate-700) | `#cbd5e1` (slate-300) |
| `--border-subtle` | `rgba(0,0,0,0.1)` | `rgba(255,255,255,0.05)` |
| `--glass-bg` | `rgba(255,255,255,0.8)` | `rgba(15,23,42,0.8)` |
| `--glass-border` | `rgba(0,0,0,0.05)` | `rgba(255,255,255,0.1)` |

Use these as `bg-[var(--bg-main)]`, `text-[var(--text-main)]`, etc.

## 3. Brand Color Scale
Defined in the `@theme` block. All map to Tailwind's `brand-*` utilities.

| Token | Hex |
|-------|-----|
| `brand-50` | `#e6f5f7` |
| `brand-100` | `#c9e9ef` |
| `brand-200` | `#98d4df` |
| `brand-300` | `#63bdcc` |
| `brand-400` | `#2ca1b4` |
| `brand-500` | `#0b7285` (primary) |
| `brand-600` | `#095d6d` |
| `brand-700` | `#074955` |

## 4. Glassmorphism Utilities
Two prebuilt glass classes defined in `@layer utilities`:

- `.glass` — light-mode glass (blurred, white-tinted border, semi-opaque bg).
- `.glass-dark` — dark-mode glass (blurred, white/5 border, black/20 bg).

## 5. UI Patterns

### Animations
- `animate-pulse-slow` — slow 6s pulse (ambient background glows).
- `animate-float` — 3s vertical float (hero elements).

### Pill Buttons
Rounded-full, thin brand-colored border, hover glow/scale transition:
```jsx
className="rounded-full border border-brand-500 px-6 py-2 hover:bg-brand-500/10 hover:scale-105 transition-all"
```

### Styling Conventions
- **Utility-first**: Tailwind classes for layout, spacing, borders, and most effects.
- **Component CSS**: Only for complex keyframe animations (e.g., `Banner.css` for the scrolling text track).
- **No inline styles**: All design values come from Tailwind utilities or CSS variables.

## 6. Component Organization
Marketing components (`Hero`, `Services`, `Values`, `Process`, `Banner`, etc.) live at `front/src/components/`. Admin components are under `front/src/components/admin/` and `front/src/components/admin/shared/`. Logic is co-located with components via TanStack Query hooks.
