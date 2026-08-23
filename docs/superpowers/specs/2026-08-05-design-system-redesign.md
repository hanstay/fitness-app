# Design System Redesign — Phase 1 Fitness App

**Date**: 2026-08-05
**Status**: Approved, ready for implementation
**Scope**: Visual redesign of the existing Phase 1 multi-user Firebase app. Functionality is unchanged; this replaces the dark theme with a light-mode minimal design system and improves the onboarding UX.

## Motivation

The current app works but has two problems the user identified:
1. **Visual hierarchy feels lacking** — the dark theme is flat; it's hard to know what to focus on.
2. **Registration feels clunky** — the onboarding wizard is dense and form-heavy.

This redesign keeps all Phase 1 functionality (auth, onboarding, generation, dynamic pages) and only changes presentation: a new token system, a rebuilt onboarding wizard, and consistent card-based content pages.

## Design Direction (locked)

A light-mode, minimal aesthetic blending **Hevy's light mode** (clean white surfaces, near-black text, athletic clarity) with **BYD by 1826's** minimalism (small-radius cards, clear font-size hierarchy, generous whitespace). The accent is BYD's warm coral-red.

### Color Tokens

| Token | Value | Purpose |
|-------|-------|---------|
| `--bg-page` | `#ffffff` | Page background |
| `--bg-tint` | `#f5f8fa` | Subtle surfaces: chips, upload zones, thumbnails |
| `--card` | `#ffffff` | Card background |
| `--accent` | `#dd4045` | Primary buttons (white text), progress bars, key highlights |
| `--accent-dark` | `#c9333a` | Accent text/values on white (better contrast) |
| `--accent-soft` | `#fdecec` | Soft accent tint for icon chips |
| `--text-primary` | `#17181a` | Body text, headings |
| `--text-secondary` | `#868b94` | Supporting text, labels, meta |
| `--border` | `#e8eaed` | Card borders, dividers |
| `--warn` | `#e6a23c` | Warning states (amber) |
| `--radius` | `12px` | Card corner radius |
| `--radius-sm` | `8px` | Buttons, inputs, small elements |

Semantic mapping keeps a single accent. No gradients on content; the onboarding header may use a very subtle accent-tinted wash only.

### Typography

- **Poppins** (500/600/700) — headings, card titles. Loaded via `@font-face` (self-hosted or Google Fonts link in `<head>`).
- **Inter** (400/500/600) — body, UI, buttons, tabular data.
- Scale: 20px section headings, 17px sub-headings, 15px card titles, 13–14px body, 11–12px uppercase micro-labels (step counters, field labels) with `letter-spacing: 0.5px`.
- Headings use `letter-spacing: -0.2px` and `text-wrap: balance`.

### Components

**Buttons**
- Primary: `--accent` fill, white text, `--radius-sm`, 14px/600 Inter, 14px vertical padding, full-width in wizard.
- Secondary: white fill, `--border` border, `--text-primary` text.
- Both have hover (darken/tint) and disabled states, plus a `.spinner` busy state (already exists).

**Cards (content pattern)**
- White bg, `1px solid --border`, `--radius`, no shadow.
- List item: thumbnail chip (56px, `--bg-tint`) + info block (Poppins 600 title / gray meta) + trailing value or arrow.
- Used on dashboard, program, meals, profile scan-history.

**Form fields**
- Label: uppercase micro-label, `--text-secondary`.
- Input: white bg, `--border` border, `--radius-sm`, focus → `--accent` border.
- Grouped in fieldsets with clear vertical rhythm.

**Onboarding wizard ("Guided Card Stack")**
- Each step is one card with a header (step counter micro-label + step title) and a top progress bar that fills per step (25/50/75/100%).
- Body: large Poppins heading + supporting text, then the step's inputs, then stacked primary/secondary actions.
- Steps unchanged in function: (1) body scan, (2) integrations, (3) profile, (4) review & generate.

### Pages Affected

All in `public/`: `login.html`, `onboarding.html`, `dashboard.html`, `program.html`, `meals.html`, `profile.html`, plus `styles/theme.css` (full rewrite) and `js/onboarding-wizard.js` (markup updates only where needed).

## Architecture

- **Single source of truth**: `public/styles/theme.css` holds all tokens as CSS custom properties on `:root`, plus every shared component class. Every page links it. No per-page `<style>` blocks or inline color values.
- **No build step**: stays vanilla CSS/HTML/JS, consistent with the existing Phase 1 architecture (no bundler, no framework).
- **Fonts**: link Poppins + Inter. Prefer Google Fonts `<link>` in each page `<head>` for simplicity; if offline-resilience matters for the PWA, self-host as a follow-up.
- **Theme**: light mode only for this pass. A dark-mode token layer can be added later behind `prefers-color-scheme` without restructuring, since everything is token-driven.

## Non-Goals

- No functional changes to Cloud Functions, Firestore schema, or security rules.
- No Phase 2 features.
- No dark mode in this pass (structure allows adding it later).
- No framework/bundler migration.

## Verification

- Visual QA in the browser at desktop + mobile widths for each page.
- Confirm the onboarding flow still completes end-to-end (each step advances, buttons wired).
- Confirm no hardcoded colors remain outside `theme.css` (grep for hex values in `public/*.html`).
- Confirm contrast: coral on white and text tokens meet WCAG AA for their sizes.
