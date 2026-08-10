# Plan: Maximize Hevy data → progression + adherence for plan generation

## Context

Training principle driving this: a future plan should weigh the **goal** first, then **how the athlete is actually performing**. The goal half is handled (goal, dated events, periodization, fixed sessions). The performance half is weak: `parseHevyCsv` reduces the export to a `current_lifts` **snapshot** (latest working set per exercise, 30-day window, ≤40) and **overwrites it every import** (`hevyParser.ts`, `parseHevyCsv.ts:31`). `generateProgram` renders it as "Current lifts (most recent working sets)" (`:129`).

Consequence: no history → **no progression trend, no PRs, no adherence**. The model infers "how you're doing" from a single data point (that is why `currentState` guessed "beginner-intermediate"). Performance is a *trajectory* + *adherence*; both need history we currently throw away.

Goal: keep and analyze the Hevy history so each next-block generation is grounded in (1) **progression** — how well the athlete is actually progressing, and (2) **adherence** — how much the last block was followed. Sleep is explicitly **out of scope** for now.

## Key facts (verified)

- Hevy CSV is **per-set rows** keyed by session: `title, start_time, exercise_title, set_index, set_type, weight_kg|weight_lbs, reps` (+ `rpe, distance_km, duration_seconds` in full exports). A session = rows sharing `start_time`. Full history is recoverable.
- Prescribed side is only **semi-numeric**: `exerciseSchema` has `sets:int` but `reps` is a string ("6-8") and load is free-text `load_note` (`schemas.ts:36-44`). Hevy names ("Squat (Barbell)") won't string-match plan names ("Back Squat").
- Decision (user): **adherence is LLM-judged** from prescribed-vs-actual summaries — robust to fuzzy names/loads, minimal brittle code. Progression is computed deterministically server-side (keys on Hevy's own names, no matching needed).

## Approach

### Part 1 — Persist the Hevy training history (the enabling change)
- New pure module `functions/src/lib/hevyAnalyzer.ts` (sibling to `hevyParser.ts`, no Firebase deps): parse full CSV → normalized **sessions** `{ id, date, title, exercises: [{ name, sets: [{ weight_kg, reps, set_type, rpe? }] }] }`, grouping rows by `start_time`. `id` = deterministic hash of `start_time` → idempotent upserts on re-upload.
- `parseHevyCsv.ts`: write each session to `users/{uid}/strengthSessions/{id}` (Admin SDK, `set` with merge) **and** keep deriving `athlete.current_lifts` via existing `parseHevyCsvToCurrentLifts` (backward compat — `generateProgram` still reads it).
- `firestore.rules`: add `match /strengthSessions/{id} { allow read: if isOwner(uid); allow write: if false; }` — owner read, Functions-only write (mirror the existing `activities` seam, line 25).

### Part 2 — Derive progression metrics (server-side, in the analyzer)
Two independent progression axes per exercise (both keyed on Hevy's own names — no matching):
- **Intensity — e1RM**: Epley `weight*(1+reps/30)` per working set (rep-range-agnostic); **best e1RM (PR)** + date, **recent top set**, **6-week trend** (↑/→/↓ with kg/%).
- **Volume — tonnage**: Σ `sets·reps·weight` per movement, per-session and per-week, **6-week trend**. For bodyweight/conditioning moves, volume falls back to reps · distance · time.

These diverge usefully (volume ↑ + e1RM flat = work-capacity gain; e1RM ↑ + volume ↓ = peaking) — feed both so the model reads the pair, not one number. Plus **frequency** (sessions/week) and rolled-up progressing/stalling flags. Pure + unit-testable; `generateProgram` calls it at generation time on the stored history.

### Part 3 — Feed progression + adherence into `generateProgram`
- **Progression block** — replace the flat "Current lifts" section with **"Performance & progression (from Hevy)"**: per key lift → current top set, PR (best e1RM), 6-wk trend; + session frequency/volume trend. Distilled (key lifts, not every set) to control tokens.
- **Adherence block (LLM-judged)** — pass two compact summaries:
  - **PLANNED (last block)**: the previously-active program's `weeklyStructure`/`sessions`. `generateProgram` already queries active programs to archive them (`:161`) — reuse that read.
  - **ACTUAL (recent Hevy)**: the last block-week's `strengthSessions` — dates, exercises, top sets.
  Let the model judge adherence + deviations (e.g. RDL→hip thrust ×2 → likely equipment → consider adopting).
- **System prompt** (extend step 2 grounding): use progression to decide push/hold/deload per lift; use adherence to decide repeat/scale/adjust and to recognize consistent deviations; **never penalize missing history** — no Hevy = program as today (graceful absence, mirroring existing "not connected"/"not calculated").
- No schema change required — `currentState.highlights` (string[]) + `coachNotes` already carry these call-outs (`schemas.ts:54-58,101`).

## Screens (UI follow-on — supplements the workflow)

Backend Parts 1-3 make the data real; these give the athlete a weekly home to bring Hevy in and see what it changed. Today Hevy upload is onboarding-only, so there is no weekly entry point. Reuse `theme.css` components; small modules under `public/js/` (same pattern as `events-editor.js`).

1. **Weekly check-in hub ("This week")** — dashboard entry point: `Import Hevy CSV` + `Sync intervals.icu` + primary `Regenerate plan`. Reads `state/summary.integrationsStatus`; calls `parseHevyCsv` then `generateProgram`. This is the missing weekly re-upload home.
2. **Import summary** — after import: sessions imported, new **PRs**, per-lift **trend** chips, and the **adherence/deviation** read (e.g. "5/6 planned · RDL→Hip Thrust ×2"). Reads `strengthSessions` + derived progression. Just enough to confirm + surface signal — not a dashboard.
3. **Plan updated — what & why** — after regeneration: each change traced to a progression/adherence signal ("Squat +2.5kg — hit all sets, e1RM ↑"; "Adopted Hip Thrust for RDL"). Reads the new program's `currentState`/`coachNotes`.

Backend is the priority; screens follow once Parts 1-3 land.

## Files
- `functions/src/lib/hevyAnalyzer.ts` (new) — parse history + progression + adherence-input summaries (pure).
- `public/dashboard.html` + small `public/js/` modules (new) — the three screens above (UI follow-on).
- `functions/src/lib/hevyParser.ts` — reuse/share CSV parsing with the analyzer.
- `functions/src/integrations/parseHevyCsv.ts` — persist `strengthSessions` + keep `current_lifts`.
- `functions/src/generate/generateProgram.ts` — read history + last program; build progression + adherence prompt blocks; system-prompt additions.
- `firestore.rules` — add `strengthSessions/{id}` (owner read, Functions write).
- `functions/test/hevyAnalyzer.test.ts` (new) — e1RM, PR, trend, session grouping against the real CSV fixture (`hevyParser.test.ts` shows the fixture path/shape).

## Verification
1. Unit-test the analyzer (e1RM, PR, trend, session grouping) against the existing real Hevy fixture.
2. `npm run build`; restart emulators (see [[local-emulator-workflow]]). Import a Hevy CSV → confirm `strengthSessions/{id}` docs created; re-import an overlapping export → confirm idempotent (no dupes).
3. Regenerate the program → confirm the prompt (emulator log/saved program) carries the **progression** + **PLANNED/ACTUAL adherence** blocks and that `currentState.highlights`/`coachNotes` reflect real trend + adherence.
4. Graceful-absence: clear history → prompt shows "not tracked", generation unaffected.
5. Watch prompt size/latency ([[program-generation-latency-cost]]); trim the summaries if the ~4-min generation grows.

## Non-goals
Sleep (dropped for now) · in-app set logging (Hevy owns it) · real-time per-day auto-regulation · analytics UI (summaries are for the model). A weekly Hevy re-upload button on the dashboard is a small follow-on, not core.
