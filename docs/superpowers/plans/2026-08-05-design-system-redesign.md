# Design System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's dark theme with a light-mode, minimal design system (coral-red accent, Poppins/Inter typography, card-based content) and rebuild the onboarding wizard as a "Guided Card Stack" — without changing any functionality.

**Architecture:** Vanilla HTML/CSS/JS, no build step. A single `public/styles/theme.css` holds all design tokens (CSS custom properties on `:root`) and every shared component class; every page links it. The existing HTML already uses stable class names (`.card`, `.btn`, `.input`, `.badge`, `.hero`, `.stats`, etc.), so most of the redesign is a `theme.css` rewrite. Targeted markup changes apply only where new patterns are introduced: the onboarding wizard header/progress bar, and the content-card list pattern on dashboard/program/meals.

**Tech Stack:** HTML5, CSS custom properties, vanilla ES modules, Firebase JS SDK (unchanged), Firebase Hosting/Emulators for local preview.

## Global Constraints

- No functional changes to Cloud Functions, Firestore schema, security rules, or any JS logic — presentation only. (Onboarding wizard JS may only change DOM-structure references, not behavior.)
- All color/spacing/font values live as CSS custom properties in `public/styles/theme.css`. No hardcoded hex colors in any `public/*.html` file (existing inline `style="..."` with layout values like padding/max-width are acceptable; colors are not).
- Light mode only this pass. Keep everything token-driven so a dark layer can be added later.
- Fonts: Poppins (headings/titles) + Inter (body/UI), loaded via Google Fonts `<link>` in each page `<head>`.
- Exact token values (copy verbatim):
  - `--bg-page:#ffffff` `--bg-tint:#f5f8fa` `--card:#ffffff`
  - `--accent:#dd4045` `--accent-dark:#c9333a` `--accent-soft:#fdecec`
  - `--text-primary:#17181a` `--text-secondary:#868b94` `--border:#e8eaed`
  - `--warn:#e6a23c` `--radius:12px` `--radius-sm:8px`
- No new dependencies, no bundler, no framework.
- Verification is browser-based (Firebase emulator preview) + grep checks — there is no CSS unit-test harness, and none should be added.

---

## File Structure

- `public/styles/theme.css` — **full rewrite.** All tokens + base + every component class. Single source of truth.
- `public/login.html` — head updates (fonts, theme-color); markup already uses shared classes.
- `public/onboarding.html` — head updates + wizard markup restructure (per-step header + progress bar).
- `public/js/onboarding-wizard.js` — update progress/step DOM references to match new markup (behavior unchanged).
- `public/dashboard.html` — head updates + adopt `.item-card` list pattern for plan links.
- `public/program.html` — head updates; exercise cards restyle via theme.css (minimal markup change).
- `public/meals.html` — head updates; table + section restyle via theme.css.
- `public/profile.html` — head updates; fieldsets + scan-history via theme.css.

---

## Task 1: Rewrite theme.css (tokens, base, components)

**Files:**
- Modify (full rewrite): `public/styles/theme.css`

**Interfaces:**
- Produces (class names the HTML consumes, kept stable): `.wrap` `.wrap.narrow` `.hero` `.badge` `.badges` `.card` `.card.narrow` `.field` `.input` `fieldset.field-group` `.btn` `.btn.secondary` `.btn.google` `.btn.full` `.btn-row` `.error-msg` `.success-msg` `.spinner` `.skip-link` `.stats` `.stat` `.ex` `.load` `.pill` `.callout` `.note` `.muted` `.small` `.layout` `nav.toc` `.navtoggle` `.week` `.tablescroll` `.dot`
- Produces (new classes): `.wizard-card` `.wizard-head` `.wizard-step-label` `.wizard-title` `.progress-track` `.progress-fill` `.item-card` `.item-thumb` `.item-info` `.item-title` `.item-meta` `.item-val`

- [ ] **Step 1: Replace the `:root` token block and base element styles**

Replace lines 1–63 of `public/styles/theme.css` (the `:root` block through the `.note` rule) with the new light-mode tokens, font imports, and base styles:

```css
/* Shared design system — Phase 1 light-mode redesign (2026-08-05).
   Single source of truth: all tokens + shared components live here.
   See docs/superpowers/specs/2026-08-05-design-system-redesign.md */

@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');

:root{
  --bg-page:#ffffff; --bg-tint:#f5f8fa; --card:#ffffff;
  --accent:#dd4045; --accent-dark:#c9333a; --accent-soft:#fdecec;
  --text-primary:#17181a; --text-secondary:#868b94; --border:#e8eaed;
  --warn:#e6a23c; --radius:12px; --radius-sm:8px;
  --font-head:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-body:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0; background:var(--bg-page); color:var(--text-primary);
  font-family:var(--font-body); line-height:1.55; -webkit-font-smoothing:antialiased;
}
a{color:var(--accent-dark); text-decoration:none}
h1,h2,h3{font-family:var(--font-head); letter-spacing:-0.2px; text-wrap:balance}
.wrap{max-width:1100px; margin:0 auto; padding:0 16px}
.wrap.narrow{max-width:520px}

header.hero{
  background:var(--bg-tint); border-bottom:1px solid var(--border); padding:28px 0 24px;
}
.hero h1{margin:0 0 6px; font-size:1.5rem; font-weight:700; color:var(--text-primary)}
.hero .sub{color:var(--text-secondary); font-size:.95rem; margin:0 0 14px}
.badges{display:flex; flex-wrap:wrap; gap:8px}
.badge{
  background:var(--bg-tint); border:1px solid var(--border); color:var(--text-primary);
  padding:6px 12px; border-radius:999px; font-size:.8rem; font-weight:600;
}
.badge b{color:var(--accent-dark)}

.layout{display:grid; grid-template-columns:230px 1fr; gap:28px; padding:26px 0 60px}
nav.toc{position:sticky; top:14px; align-self:start; max-height:calc(100vh - 28px); overflow:auto}
nav.toc .toc-title{font-size:.72rem; text-transform:uppercase; letter-spacing:1px; color:var(--text-secondary); margin:6px 8px 8px}
nav.toc a{display:block; padding:7px 10px; border-radius:var(--radius-sm); color:var(--text-secondary); font-size:.86rem; font-weight:500; border-left:2px solid transparent}
nav.toc a:hover{background:var(--bg-tint); color:var(--text-primary)}
nav.toc a.active{background:var(--bg-tint); color:var(--text-primary); border-left-color:var(--accent)}

main{min-width:0}
section{
  background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
  padding:20px 22px; margin:0 0 18px; scroll-margin-top:14px;
}
section h2{margin:0 0 12px; font-size:1.15rem; font-weight:600; display:flex; align-items:center; gap:9px; color:var(--text-primary)}
section h2 .dot{width:8px; height:8px; border-radius:50%; background:var(--accent); flex:none}
section h3{margin:18px 0 8px; font-size:1rem; color:var(--accent-dark)}
p{margin:0 0 10px}
.muted{color:var(--text-secondary)}
.small{font-size:.86rem}
ul{margin:0 0 10px; padding-left:20px}
li{margin:4px 0}
.note{color:var(--text-secondary); font-size:.85rem; font-style:italic}
```

- [ ] **Step 2: Update the tables / week grid / exercise card / callout / stat block (lines ~65–105 of the original)**

Replace the "Tables" through "Status stat row" sections with token-driven versions:

```css
.tablescroll{overflow-x:auto; -webkit-overflow-scrolling:touch; margin:0 0 6px}
table{border-collapse:collapse; width:100%; font-size:.88rem; min-width:480px}
th,td{text-align:left; padding:9px 11px; border-bottom:1px solid var(--border); vertical-align:top}
th{color:var(--text-secondary); font-size:.72rem; text-transform:uppercase; letter-spacing:.6px; font-weight:600}
tbody tr:hover{background:var(--bg-tint)}
td b{color:var(--text-primary)}
td.n, th.n{text-align:right; font-variant-numeric:tabular-nums}
tr.total td{font-weight:700; border-top:2px solid var(--border); color:var(--text-primary)}

.week{display:grid; grid-template-columns:repeat(7,1fr); gap:8px; margin-top:6px}
.day{background:var(--bg-tint); border:1px solid var(--border); border-radius:10px; padding:10px; font-size:.8rem}
.day .d{font-weight:700; color:var(--accent-dark); font-size:.72rem; text-transform:uppercase; letter-spacing:.5px}
.day.rest{opacity:.6}
.day.lift{border-color:var(--accent)}

.ex{margin:8px 0; padding:12px 14px; background:var(--card); border:1px solid var(--border); border-radius:10px}
.ex .name{font-weight:600; color:var(--text-primary)}
.ex .sets{color:var(--accent-dark); font-weight:700; font-size:.86rem; white-space:nowrap}
.ex .row{display:flex; justify-content:space-between; gap:12px; align-items:baseline}
.ex .load{display:inline-block; margin-top:6px; background:var(--bg-tint); color:var(--text-secondary); border:1px solid var(--border); border-radius:7px; padding:2px 8px; font-size:.76rem; font-weight:600}
.pill{display:inline-block; background:var(--accent-soft); color:var(--accent-dark); border:1px solid #f3cfd0; border-radius:999px; padding:2px 10px; font-size:.72rem; font-weight:700; margin-bottom:8px}

.callout{border-left:3px solid var(--accent); background:var(--bg-tint); padding:10px 14px; border-radius:0 10px 10px 0; margin:10px 0; font-size:.9rem}
.callout.warn{border-color:var(--warn)}

.stats{display:flex; flex-wrap:wrap; gap:10px; margin:4px 0 12px}
.stat{background:var(--bg-tint); border:1px solid var(--border); border-radius:10px; padding:11px 14px; flex:1; min-width:120px}
.stat .k{font-size:.7rem; text-transform:uppercase; letter-spacing:.6px; color:var(--text-secondary); font-weight:600}
.stat .v{font-size:1.15rem; font-weight:700; margin-top:2px; color:var(--text-primary)}
.stat .v.warn{color:var(--warn)}

footer{color:var(--text-secondary); font-size:.8rem; text-align:center; padding:24px 0 50px}
```

- [ ] **Step 3: Update the card / form / button / message / spinner components (original lines ~107–161)**

Replace with:

```css
.card{background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:22px 24px; margin:0 0 18px}
.card.narrow{max-width:440px; margin:0 auto}

.field{margin:0 0 16px}
.field label{display:block; font-size:.72rem; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.4px; margin:0 0 7px}
.field .hint{font-size:.78rem; color:var(--text-secondary); margin-top:5px}
.input, select.input, textarea.input{
  width:100%; background:var(--card); border:1px solid var(--border); color:var(--text-primary);
  border-radius:var(--radius-sm); padding:11px 12px; font-size:.94rem; font-family:inherit;
}
.input:focus, select.input:focus, textarea.input:focus{outline:none; border-color:var(--accent)}
textarea.input{resize:vertical; min-height:70px}
fieldset.field-group{border:1px solid var(--border); border-radius:10px; padding:16px; margin:0 0 16px}
fieldset.field-group legend{padding:0 6px; font-size:.72rem; font-weight:700; color:var(--accent-dark); text-transform:uppercase; letter-spacing:.5px}
.checkbox-row{display:flex; align-items:center; gap:8px; margin:6px 0; font-size:.9rem}

.btn{
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  background:var(--accent); color:#ffffff; border:none; border-radius:var(--radius-sm);
  padding:13px 20px; font-size:.94rem; font-weight:600; cursor:pointer; font-family:var(--font-body);
}
.btn:hover{background:var(--accent-dark)}
.btn:disabled{opacity:.5; cursor:not-allowed}
.btn.secondary{background:var(--card); color:var(--text-primary); border:1px solid var(--border)}
.btn.secondary:hover{background:var(--bg-tint)}
.btn.google{background:var(--card); color:var(--text-primary); border:1px solid var(--border)}
.btn.full{width:100%}
.btn-row{display:flex; gap:10px; margin-top:18px}

.error-msg{background:var(--accent-soft); border:1px solid #f3cfd0; color:var(--accent-dark); border-radius:var(--radius-sm); padding:10px 13px; font-size:.86rem; margin:0 0 14px}
.success-msg{background:#eaf7ee; border:1px solid #bfe3c9; color:#1c7a3e; border-radius:var(--radius-sm); padding:10px 13px; font-size:.86rem; margin:0 0 14px}

.spinner{display:inline-block; width:16px; height:16px; border:2px solid #ffffff66; border-top-color:#ffffff; border-radius:50%; animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.btn.secondary .spinner, .btn.google .spinner{border:2px solid var(--border); border-top-color:var(--accent)}
.skip-link{display:block; text-align:center; margin-top:14px; font-size:.86rem; color:var(--text-secondary)}
```

- [ ] **Step 4: Add the new wizard + item-card components (replaces the old `.step-indicator` block)**

Remove the old `.step-indicator` rules and add:

```css
/* Guided-card-stack wizard */
.wizard-card{background:var(--card); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; margin:0 0 18px}
.wizard-head{padding:18px 22px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; gap:16px; background:var(--bg-tint)}
.wizard-step-label{font-size:.68rem; font-weight:600; text-transform:uppercase; letter-spacing:.6px; color:var(--text-secondary); margin:0 0 3px}
.wizard-title{font-family:var(--font-head); font-size:1rem; font-weight:600; color:var(--text-primary); margin:0}
.progress-track{width:64px; height:4px; background:var(--border); border-radius:2px; overflow:hidden; flex:none}
.progress-fill{height:100%; background:var(--accent); transition:width .3s ease}
.wizard-body{padding:24px 22px}
.wizard-body > h3{font-family:var(--font-head); font-size:1.25rem; font-weight:700; color:var(--text-primary); margin:0 0 6px; letter-spacing:-0.3px}
.wizard-body > .lead{font-size:.9rem; color:var(--text-secondary); line-height:1.6; margin:0 0 20px}

/* Content list card */
.item-card{display:flex; gap:14px; padding:14px; background:var(--card); border:1px solid var(--border); border-radius:var(--radius); margin:0 0 12px; align-items:center; text-decoration:none}
.item-card:hover{background:var(--bg-tint)}
.item-thumb{width:52px; height:52px; border-radius:10px; background:var(--bg-tint); flex:none; display:flex; align-items:center; justify-content:center; font-size:20px}
.item-info{flex:1; min-width:0}
.item-title{font-family:var(--font-head); font-size:.98rem; font-weight:600; color:var(--text-primary); margin:0 0 3px}
.item-meta{font-size:.8rem; color:var(--text-secondary)}
.item-val{font-size:.98rem; font-weight:700; color:var(--accent-dark); font-variant-numeric:tabular-nums; flex:none}
```

- [ ] **Step 5: Update the mobile / print / standalone media queries (original lines ~163–193)**

Replace the old-token references in the print block and keep mobile/standalone rules, swapping token names:

```css
.navtoggle{display:none}
@media (max-width:820px){
  .layout{grid-template-columns:1fr; gap:0; padding-top:14px}
  nav.toc{position:static; max-height:none; margin-bottom:16px; background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:10px}
  nav.toc .links{display:none}
  nav.toc.open .links{display:block}
  .navtoggle{display:flex; justify-content:space-between; align-items:center; width:100%; background:none; border:0; color:var(--text-primary); font-size:.95rem; font-weight:600; padding:4px 6px; cursor:pointer}
  .navtoggle span.arrow{transition:transform .2s}
  nav.toc.open .navtoggle span.arrow{transform:rotate(180deg)}
  .week{grid-template-columns:1fr 1fr}
  .hero h1{font-size:1.3rem}
  .wizard-head{padding:16px 18px}
  .wizard-body{padding:20px 18px}
}
@media print{
  nav.toc,.navtoggle{display:none}
  .layout{grid-template-columns:1fr}
  section{break-inside:avoid; border:1px solid #ddd}
  body{background:#fff}
}
@media (display-mode:standalone),(display-mode:fullscreen){
  header.hero{padding-top:calc(28px + env(safe-area-inset-top,0px))}
}
.wrap{padding-left:calc(16px + env(safe-area-inset-left,0px));padding-right:calc(16px + env(safe-area-inset-right,0px))}
footer{padding-bottom:calc(50px + env(safe-area-inset-bottom,0px))}
```

- [ ] **Step 6: Verify no old tokens remain**

Run: `grep -nE '#0f1115|#171a21|#1e222b|#16c79a|#3da9fc|--surface|--muted:|--line:|--accent2' public/styles/theme.css`
Expected: no matches (empty output).

- [ ] **Step 7: Commit**

```bash
git add public/styles/theme.css
git commit -m "redesign: rewrite theme.css with light-mode token system"
```

---

## Task 2: Update login.html head + establish shared head pattern

**Files:**
- Modify: `public/login.html` (head only)

**Interfaces:**
- Consumes: Task 1 classes (`.hero` `.card` `.btn` `.input` `.field`).
- Produces: the shared `<head>` snippet (theme-color + font preconnect) reused by all later page tasks.

- [ ] **Step 1: Update the theme-color meta and add font preconnect**

In `public/login.html`, change:
```html
<meta name="theme-color" content="#0f1115">
```
to:
```html
<meta name="theme-color" content="#ffffff">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```
(The `@import` in theme.css loads the fonts; preconnect just speeds it up.)

- [ ] **Step 2: Remove the inline divider hardcoded colors**

In the "or" divider block (around line 48–52), the two divider lines use `background:var(--line)`. Change both `var(--line)` to `var(--border)`, and `color:var(--muted)` to `color:var(--text-secondary)`.

- [ ] **Step 3: Verify no stale tokens in login.html**

Run: `grep -nE 'var\(--line\)|var\(--muted\)|var\(--surface|#0f1115' public/login.html`
Expected: no matches.

- [ ] **Step 4: Visual check**

Start the emulator: `firebase emulators:start` (or if already running, reload). Open `http://localhost:5000/login.html`. Confirm: white background, coral primary button, Inter/Poppins fonts loaded, Google button is outlined not white-on-white.

- [ ] **Step 5: Commit**

```bash
git add public/login.html
git commit -m "redesign: update login.html head + divider tokens"
```

---

## Task 3: Rebuild onboarding.html as Guided Card Stack + update wizard JS

**Files:**
- Modify: `public/onboarding.html` (head + wrap each step in wizard-card markup)
- Modify: `public/js/onboarding-wizard.js` (progress/step DOM references only)

**Interfaces:**
- Consumes: Task 1 wizard classes (`.wizard-card` `.wizard-head` `.wizard-step-label` `.wizard-title` `.progress-track` `.progress-fill` `.wizard-body`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Read the current wizard JS to find how it shows/advances steps**

Run: `grep -nE 'step|Step|progress|indicator|display' public/js/onboarding-wizard.js`
Note which element IDs/classes it toggles (e.g. `#step1`..`#step4`, `.step-indicator .step`, `#stepSub`). The rebuild must keep the same `#step1`..`#step4` section IDs so the JS's show/hide logic keeps working.

- [ ] **Step 2: Update the head**

Apply the same head change as Task 2 Step 1 (theme-color `#ffffff` + font preconnect) to `public/onboarding.html`.

- [ ] **Step 3: Replace the step-indicator block with a per-step wizard-card structure**

Remove the old `<div class="step-indicator">…</div>` (lines ~26–31). Wrap each `<section id="stepN" class="card">` so it becomes a `.wizard-card`. For each step, replace the opening `<section id="stepN" class="card">` and its first `<h2>` with:

```html
<section id="step1" class="wizard-card">
  <div class="wizard-head">
    <div>
      <p class="wizard-step-label">Step 1 of 4</p>
      <p class="wizard-title">Body scan (optional)</p>
    </div>
    <div class="progress-track"><div class="progress-fill" id="progress1" style="width:25%"></div></div>
  </div>
  <div class="wizard-body">
    <h3>Upload a body scan</h3>
    <p class="lead">Visbody, Evolt, or similar. We'll pull your weight and body fat % straight from the report — you'll review before anything is saved.</p>
    <!-- keep the existing fields/buttons for this step here -->
```
Close each step with `</div></section>`. Repeat for step2 (`50%`, "Connect your data"), step3 (`75%`, "Your profile"), step4 (`100%`, "Review & generate") — moving the existing inner fields/buttons of each step into the new `.wizard-body`. Keep every existing input `id` and button `id` unchanged.

- [ ] **Step 4: Update wizard JS step-indicator references**

In `public/js/onboarding-wizard.js`, find any code that manipulated `.step-indicator .step` classes (add/remove `active`/`done`). Since the visual progress is now the header's fixed per-step `progress-fill` width, delete only that step-indicator class-toggling code. Do NOT change the section show/hide logic (`#step1`..`#step4`) or any submit handlers. If the JS also updated a `#stepSub` text, that element no longer exists — remove that line too.

- [ ] **Step 5: Verify the JS no longer references removed elements**

Run: `grep -nE 'step-indicator|stepSub|\.step\b' public/js/onboarding-wizard.js`
Expected: no matches (or only unrelated matches like `step1`).

- [ ] **Step 6: Visual + functional check in the emulator**

Reload `http://localhost:5000/onboarding.html` (sign up first via login if redirected). Confirm: each step shows as a card with a header + progress bar; the four steps still advance via their existing buttons; skip links work; the profile form saves. Walk all 4 steps end to end.

- [ ] **Step 7: Commit**

```bash
git add public/onboarding.html public/js/onboarding-wizard.js
git commit -m "redesign: rebuild onboarding as guided card stack"
```

---

## Task 4: Rebuild dashboard.html with item-card pattern

**Files:**
- Modify: `public/dashboard.html`

**Interfaces:**
- Consumes: Task 1 classes (`.item-card` `.item-thumb` `.item-info` `.item-title` `.item-meta` `.item-val` `.badge` `.stats` `.stat`).

- [ ] **Step 1: Update the head** — apply the Task 2 Step 1 head change to `public/dashboard.html`.

- [ ] **Step 2: Replace the "Your plan" link row with item-cards**

Replace the `.btn-row` of `<a>` links (lines ~35–40) with item-card anchors:
```html
<a class="item-card" href="program.html">
  <span class="item-thumb">&#127947;</span>
  <span class="item-info"><span class="item-title">Training program</span><span class="item-meta">View your current split</span></span>
  <span class="item-val">&rarr;</span>
</a>
<a class="item-card" href="meals.html">
  <span class="item-thumb">&#127869;</span>
  <span class="item-info"><span class="item-title">Meal plan</span><span class="item-meta">Meals that hit your macros</span></span>
  <span class="item-val">&rarr;</span>
</a>
<a class="item-card" href="profile.html">
  <span class="item-thumb">&#9881;</span>
  <span class="item-info"><span class="item-title">Profile</span><span class="item-meta">Stats, training, diet prefs</span></span>
  <span class="item-val">&rarr;</span>
</a>
```
Keep the "Training load", "Regenerate", and "Sign out" sections as-is (they already use `.stats`/`.btn` which Task 1 restyled). Confirm the inline `.warn` style on TSB still reads (it uses `--warn`).

- [ ] **Step 3: Check the training-load `asOf` and inline styles** — no hardcoded colors were added; the section uses `.stat`/`.v.warn` from theme.css. No change needed beyond Step 2.

- [ ] **Step 4: Visual check** — reload `http://localhost:5000/dashboard.html`. Confirm the three plan links render as cards, badges show coral numbers, buttons are coral/outlined correctly.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "redesign: dashboard item-card layout"
```

---

## Task 5: Restyle program.html

**Files:**
- Modify: `public/program.html` (head only; cards restyle via theme.css)

- [ ] **Step 1: Update the head** — apply the Task 2 Step 1 head change to `public/program.html`.

- [ ] **Step 2: Verify no hardcoded colors** — Run: `grep -nE '#[0-9a-fA-F]{6}|var\(--line|var\(--surface|var\(--muted|var\(--accent2' public/program.html` — Expected: only `#ffffff` in the theme-color meta; no other hex, no stale tokens.

- [ ] **Step 3: Visual check** — reload `http://localhost:5000/program.html` (must have a generated program; generate one from the dashboard if empty). Confirm: exercise `.ex` cards, `.load` tags, `.badge`s, TOC sidebar + scrollspy all render in the light theme.

- [ ] **Step 4: Commit**

```bash
git add public/program.html
git commit -m "redesign: program.html head + light theme"
```

---

## Task 6: Restyle meals.html

**Files:**
- Modify: `public/meals.html` (head only; tables/sections restyle via theme.css)

- [ ] **Step 1: Update the head** — apply the Task 2 Step 1 head change to `public/meals.html`.

- [ ] **Step 2: Verify no hardcoded colors** — Run: `grep -nE '#[0-9a-fA-F]{6}|var\(--line|var\(--surface|var\(--muted|var\(--accent2' public/meals.html` — Expected: only `#ffffff` in theme-color meta.

- [ ] **Step 3: Visual check** — reload `http://localhost:5000/meals.html` (generate a meal plan first if empty). Confirm: day tables, totals row, grocery list, `.callout` notes, TOC render correctly in light theme.

- [ ] **Step 4: Commit**

```bash
git add public/meals.html
git commit -m "redesign: meals.html head + light theme"
```

---

## Task 7: Restyle profile.html

**Files:**
- Modify: `public/profile.html` (head only; fieldsets/scan-history restyle via theme.css)

- [ ] **Step 1: Update the head** — apply the Task 2 Step 1 head change to `public/profile.html`.

- [ ] **Step 2: Verify no hardcoded colors** — Run: `grep -nE '#[0-9a-fA-F]{6}|var\(--line|var\(--surface|var\(--muted|var\(--accent2' public/profile.html` — Expected: only `#ffffff` in theme-color meta.

- [ ] **Step 3: Visual check** — reload `http://localhost:5000/profile.html`. Confirm: all fieldsets, inputs (coral focus border), save/recalc buttons, and the body-scan history `.ex` cards render in light theme. Test the Save button still writes.

- [ ] **Step 4: Commit**

```bash
git add public/profile.html
git commit -m "redesign: profile.html head + light theme"
```

---

## Task 8: Final QA sweep

**Files:** none (verification + any fixes surfaced).

- [ ] **Step 1: Repo-wide stale-token/hardcoded-color grep**

Run: `grep -rnE '#0f1115|#171a21|#1e222b|#16c79a|#3da9fc|var\(--line\)|var\(--muted\)|var\(--surface|var\(--accent2\)' public/`
Expected: no matches. Fix any stragglers, committing each fix.

- [ ] **Step 2: Confirm every page links theme.css and sets theme-color #ffffff**

Run: `grep -Ln 'styles/theme.css' public/login.html public/onboarding.html public/dashboard.html public/program.html public/meals.html public/profile.html`
Expected: empty (all files contain it). Then run: `grep -rn 'name="theme-color"' public/*.html` and confirm every value is `#ffffff`.

- [ ] **Step 3: Mobile-width visual pass**

In the browser, set viewport to 375px wide. Reload each page. Confirm: no horizontal body scroll, TOC collapses to the mobile toggle on program/meals, wizard cards fit, item-cards wrap cleanly.

- [ ] **Step 4: Full flow smoke test**

In the emulator: sign up → walk onboarding (all 4 steps) → land on dashboard → open program, meals, profile. Confirm nothing is functionally broken and the theme is consistent everywhere.

- [ ] **Step 5: Final commit (if any fixes were made)**

```bash
git add -A public/
git commit -m "redesign: final QA fixes"
```

---

## Self-Review Notes

- **Spec coverage:** Every spec section maps to a task — tokens/base/components → Task 1; per-page application → Tasks 2–7; verification (grep for stray hex, mobile/desktop QA) → Task 8. Typography (Poppins/Inter) → Task 1 Step 1 `@import`. Wizard "Guided Card Stack" → Task 3. Item-card pattern → Task 1 (styles) + Task 4 (usage).
- **Placeholder scan:** All CSS/markup steps contain literal code; no TBD/TODO. Verification steps give exact grep commands and expected results.
- **Type consistency:** Class names produced in Task 1's Interfaces block are the exact ones consumed in Tasks 3–4 (`.wizard-card`, `.item-card`, etc.). Section IDs `#step1..#step4` preserved so wizard JS keeps working (Task 3 Step 3 explicitly keeps them).
