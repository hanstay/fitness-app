# UI/UX Polish Plan — Phase 2

**Date**: 2026-08-23
**Status**: Draft, for discussion
**Scope**: No new features. Fixes to perceived quality/trust issues in the existing light-mode app (`public/*.html`) that make it feel unfinished or deterring, especially on first load and slow connections.

## Motivation

The Phase 1 redesign (2026-08-05) fixed the visual system (colors, type, cards). What's left is **state-transition and finish-work polish** — the things a user notices in the first 2 seconds of opening the app, or on a slow connection, that make it feel unreliable even though the underlying functionality is solid.

Two categories of findings below, from re-reading the actual routing/auth code and CSS:

## A. Confirmed root causes

### A1. Every protected page flashes its full authenticated UI before the auth check resolves
Every page (`dashboard.html`, `program.html`, `meals.html`, `profile.html`, `checkin.html`) renders its complete `<header>`/`<section>` markup directly in `<body>`. The `requireOnboarded()` / `requireAuth()` call happens inside a `<script type="module">` at the bottom, which is async (`onAuthStateChanged` is not synchronous — it can take a noticeable moment, longer on cold Firebase SDK load). Result: signed-out users briefly see the dashboard shell (header "Your plan", empty sections) before being redirected to `login.html`. Same shape of flash on every other protected page.

### A2. `index.html` unconditionally redirects to `login.html`, then `login.html` may redirect again
`index.html` has `<meta http-equiv="refresh" content="0; url=login.html">` with no auth check at all — it *always* goes to the login page first, even for an already-signed-in user. `login.html` then runs `redirectIfSignedIn()`, which itself awaits `onAuthStateChanged` before bouncing to `dashboard.html` or `onboarding.html`. So a returning logged-in user's cold-load path is: blank → login page paints → (wait for Firebase) → redirect to dashboard → dashboard paints its shell → (wait for a second `onAuthStateChanged` + a Firestore `getDoc`) → real content. That's up to 3 full page paints before anything useful shows, which reads as broken/slow rather than "loading."

### A3. No shared loading state
There's no skeleton, spinner-over-content, or `<body hidden>` pattern anywhere except inline entity-level ones (e.g., dashboard's "Loading…" text in `#targetsSub`, generation-card spinners). The *page-level* transition (auth check → redirect or reveal) has zero visual treatment — it's either fully-rendered-wrong-content or a hard navigation.

### A4. Typography/spacing inconsistencies from inline styles
Several pages reach for one-off inline `style="..."` instead of the shared `.stats`/`.field`/`.card` rhythm already defined in `theme.css` (e.g. dashboard's divider row uses inline flex + margins; `.btn-row` gets ad hoc `style="flex-wrap:wrap"`). This is what's producing the "font with lack of paddings" feel — not a token problem (the tokens are fine), but inconsistent application of them page-to-page.

### A5. Errors are page-specific and easy to miss
`#errorBox`/`#successBox` are plain colored `<div>`s with no `aria-live`, no auto-scroll-into-view, and no auto-dismiss — on a long page (onboarding, profile) an error at the top can render off-screen from where the user is scrolled, silently.

## B. Plan

### Phase 1 — Kill the flash (highest impact, lowest risk)
1. Add a tiny shared boot pattern: every page's `<body>` gets a `data-auth="pending"` attribute and a `body[data-auth="pending"] > *:not(#authGate){visibility:hidden}` rule (or a full-screen `#authGate` loading veil) in `theme.css`. Auth-guard helpers flip `data-auth` to `"ready"` right before returning, or navigate away while still hidden. One CSS rule + a one-line attribute flip in `auth-guard.js` covers all 5 protected pages at once.
2. Give the veil actual content: centered logo/spinner, not just blank white — blank-white-then-pop still reads as a glitch; a branded loading state reads as intentional.
3. Fix `index.html`: check auth state there directly (it already has to load Firebase either way) and route straight to `dashboard.html`/`onboarding.html`/`login.html` — collapsing the current index→login→dashboard double-hop into a single redirect for the common "already logged in" case.

### Phase 2 — Consistent loading & empty states
4. Replace ad hoc "Loading…" text nodes with a shared `.skeleton` shimmer block style (a few CSS-only placeholder bars) for the dashboard target badges / plan cards while the first `onSnapshot` payload is in flight — right now those elements are just empty until data arrives.
5. Audit every `await`/`onSnapshot` call across the 6 pages and confirm each has a paired loading + error UI state (some, like `profile.html`'s scan history, may currently just stay blank on failure).

### Phase 3 — Spacing/typography sweep
6. Pull all inline `style="..."` layout rules (margins, flex, padding) out of the HTML files into small utility classes in `theme.css` (`.divider`, `.wrap-row`, etc.), so spacing is consistent and auditable in one place instead of drifting per-page.
7. Pass over line-height/padding on dense screens (onboarding step forms, checkin history) specifically for the "cramped text" complaint — likely candidates: `.field` vertical rhythm on mobile widths, `.item-card` padding at narrow viewports.

### Phase 4 — Feedback & error visibility
8. Make `#errorBox`/`#successBox` a shared component: `aria-live="polite"`, `scrollIntoView({behavior:'smooth'})` on show, and auto-dismiss for success messages after a few seconds.
9. Toast-style confirmation for background actions (e.g. "Regenerate" on dashboard) instead of relying solely on the small `.note` status line, which is easy to miss below the fold.

## Sequencing & risk

Phase 1 is pure CSS + a ~10-line change to `auth-guard.js`, touches no business logic, and directly fixes the most visible complaint (the login/dashboard/program flash). Recommend doing it first and shipping it alone before the rest. Phases 2–4 are cosmetic/incremental and can land independently in any order.

## Out of scope
No visual redesign, no new pages, no framework migration. This is a finishing pass on the existing light-mode system from the 2026-08-05 spec.
