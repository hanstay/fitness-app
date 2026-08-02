# Phase 1: Multi-User Firebase Web App for Personal Trainer Toolkit

## Context

The Personal Trainer Toolkit currently runs as a set of Claude Code skills that read/write local markdown files (`personal-trainer/users/<name>/...`) and regenerate static HTML pages that get git-committed and pushed to `hj-2t3of5`, a GitHub Pages site. Onboarding a new person today means an engineer manually running PowerShell scripts (`new-user.ps1`, `select-user.ps1`), hand-filling markdown profile templates through a Claude Code conversation, and running local sync scripts for Hevy/intervals.icu — the exact friction this session went through onboarding a real user (`maoledies`). That doesn't scale past a couple of hand-held users.

The request is to turn `hj-2t3of5` into a real multi-user web app: people sign up, connect their own data sources or fill a form, get a generated program + meal plan, and (in a later phase) log workouts/macros and get check-ins — all backed by a database instead of files a human edits by hand.

Investigation (three parallel explorations) surfaced a critical fact that shapes this whole plan: **the current live app has zero authentication anywhere.** The Firebase project already wired into `hj-2t3of5` runs a Realtime Database in fully open test-mode rules (`.write: true`, no auth), used only for an unauthenticated cross-partner "messages" feature (`remote.html`). This plan doesn't just add multi-user features on top of the current app — it replaces an open, static-file publishing model with a properly access-controlled one.

**Decisions locked in during scoping** (do not revisit without cause):
- Extend the existing Firebase project. Use **Firestore** (not Realtime Database) as the primary store, **Firebase Auth** (Email/Password + Google Sign-In) for real accounts, **Cloud Functions** for backend logic, **Firebase Hosting** to eventually replace GitHub Pages.
- Scale target: ~10-50 users (friends/small community). Real auth + proper Security Rules required; no need for production-grade abuse/rate-limiting infra.
- Judgment-heavy logic (program generation, meal planning, body-scan extraction) calls the **Claude API server-side** from Cloud Functions, using a Functions secret — never exposed client-side.
- **No data migration.** Fresh start; the two real users' existing local files are not ported in.
- **Messages feature retired** — not migrated. The Realtime Database instance gets **deleted** from the live Firebase project once this ships (closes the standing open-write hole).
- Work happens on a **new branch** (`feature/multiuser-firebase`) inside the existing `hj-2t3of5` repo. `main`/current GitHub Pages site stays untouched and live during the build; cutover is a separate future decision.
- **Two-phase delivery — this plan is Phase 1 only.** Phase 1 = auth, profiles, onboarding (including body-scan upload and Hevy CSV import), program/meal-plan generation, dynamic viewing pages. **Phase 2 (not this plan)** = workout logging, macro tracking + Scoreboard, check-ins, intervals.icu activity sync. Phase 1's schema reserves the seams Phase 2 needs so nothing gets reworked later.
- Body-scan upload and manual weight/body-fat entry are **coupled, not parallel paths**: uploading a scan PDF extracts the numbers via Claude and pre-fills the profile fields, so the user never re-enters what the scan already gave them (they review/correct before confirming, they don't retype).
- Hevy CSV upload gets a **real parse in Phase 1** (ported from the existing `sync-hevy.ps1` logic — deterministic, not LLM), seeding "current lifts" into the profile during onboarding.
- **intervals.icu activity + wellness sync also happens in Phase 1**, not deferred — it's foundational grounding for the system's understanding of a user (training load, recent activity), not just a credential-storage step. Saving a verified intervals.icu credential auto-triggers an initial sync; on-demand re-sync (a "Sync Now" action) is in Phase 1 too. Only *scheduled/automatic recurring* re-sync is deferred to Phase 2.

---

## Architecture Summary

Firebase Auth → Firestore (owner-scoped documents/subcollections) → Cloud Functions (1 Auth trigger + 7 callables; 3 of which call the Claude API server-side) → static multi-page vanilla-JS frontend on Firebase Hosting, reusing the existing dark-theme CSS design system. No Realtime Database, no bundler, no frontend framework.

---

## Firestore Schema

Three top-level collections: `users` (owner read; profile fields owner-write, everything else Functions-only), `credentials` (Admin-SDK-only, never client-reachable), and per-user subcollections under `users/{uid}`.

```
users/{uid}                                   # owner read; athlete/nutrition fields owner-write
  uid, email, displayName: string
  createdAt: Timestamp
  onboarding: { completed: bool, step: "scan"|"integrations"|"profile"|"review"|"done", updatedAt }

  athlete: {
    sex, age, height_cm, bodyweight_kg, bodyweight_date, body_fat_pct,
    activity_level: "sedentary"|"light"|"moderate"|"very_active",
    equipment: string[], training_days_per_week, session_length_minutes,
    preferred_split, training_experience_years, injuries_constraints (free text, length-capped),
    events: [{ name, date }], goal, current_lifts: [{ exercise, weight_kg, reps, date }],
    recovery: { sleep_hours, sleep_quality, stress_1_10 }
  }

  nutrition: {
    diet_style, allergies: string[], foods_to_avoid: string[], preferred_cuisines: string[],
    meals_per_day, cooking_time_preference, eat_out_frequency, budget_preference, supplements: string[]
  }

users/{uid}/state/summary                     # Functions-only write, owner read — single doc
  currentTargets: { bmr, tdee, activity_factor, target_calories, protein_g, carbs_g, fat_g, calculated_at } | null
  currentTargetHistoryId, currentProgramId, currentMealPlanId: string | null
  wellness: { ctl, atl, tsb, asOf: Timestamp } | null       # latest snapshot, for dashboard display
  integrationsStatus: {
    intervalsIcu: { connected, athleteId, verifiedAt, lastSyncedAt, activitiesSynced: number, lastError }
    hevy: { csvUploaded, storagePath, parsedAt, liftsImported: number, lastError }
  }

users/{uid}/targetHistory/{autoId}             # Functions-only write, owner read — append-only
  bmr, tdee, activity_factor, target_calories, protein_g, carbs_g, fat_g, calculated_at
  source: "onboarding"|"checkin"               # "checkin" = Phase 2 seam
  inputs: { bodyweight_kg, age, height_cm, sex, activity_level }   # snapshot for reproducibility

users/{uid}/programs/{programId}               # Functions-only write, owner read
  createdAt, status: "active"|"archived", model: string
  split, daysPerWeek,
  sessions: [{ day, label, exercises: [{ name, sets, reps, rir, rest_seconds, load_note, substitution_note }] }]
  progressionRules, deloadGuidance, warmupNotes, profileSnapshot: object

users/{uid}/mealPlans/{mealPlanId}             # Functions-only write, owner read
  createdAt, status: "active"|"archived", targetsSnapshot: { kcal, p, c, f }
  days: [{ label, meals: [{ name, items, kcal, protein_g, carbs_g, fat_g, notes }], totals }]
  groceryList: string[], notes

users/{uid}/bodyScans/{scanId}                 # owner read + limited owner update (see Rules)
  date: Timestamp, source: "visbody"|"evolt"|"other"
  storagePath: string                          # users/{uid}/bodyscans/{scanId}.pdf
  extracted: {
    weight_kg, body_fat_pct, muscle_mass_kg, skeletal_muscle_mass_kg,
    bmr_kcal, visceral_fat_level, bmi, whr, posture_findings: string|null
  }
  extractedAt: Timestamp, confirmedByUser: bool, rawModelOutput: string|null

users/{uid}/activities/{activityId}            # Functions-only write, owner read — Phase 1, populated by intervals.icu sync
  date: Timestamp, type: string, name: string
  distance_km, duration_s, pace, avg_hr, training_load: number|null
  ctl, atl, tsb: number|null                    # wellness snapshot as of this activity's date
  syncedAt: Timestamp, raw: object               # original API payload, for reprocessing if parsing improves

# ── Phase 2 seams — schema reserved now, not populated by Phase 1 ──
users/{uid}/workouts/{workoutId}               # owner read/write — structured logging form
users/{uid}/nutritionDays/{YYYY-MM-DD}         # owner read/write — feeds Phase 2 Scoreboard
users/{uid}/checkins/{checkinId}               # Functions-only write — check-in LLM output

credentials/{uid}                              # Admin SDK / Functions ONLY, no client rule ever grants this
  intervalsIcu: { athleteId, apiKey, verifiedAt, lastVerifyError }
  updatedAt: Timestamp
```

**Why `state/summary` is split out**: it makes "can the client write X" a per-collection rule instead of field-level logic on one shared document — simpler to audit and to test.

**Why `bodyScans` allows owner *update* (unlike programs/mealPlans, which are pure Functions output)**: extraction can be wrong, and the whole point of the coupling requirement is that the user reviews and corrects extracted numbers before they land in their profile — they need to be able to edit `extracted.*` and flip `confirmedByUser`. Creation stays Functions-only (tied to the Storage upload + Claude call); only mutation of an existing doc's extracted fields is owner-writable.

---

## Firestore Security Rules

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    function isOwner(uid) { return signedIn() && request.auth.uid == uid; }

    match /users/{uid} {
      allow read: if isOwner(uid);
      allow update: if isOwner(uid) && request.resource.data.uid == uid;
      allow create: if false;   // seeded server-side by onUserCreate only
      allow delete: if false;

      match /state/summary       { allow read: if isOwner(uid); allow write: if false; }
      match /targetHistory/{id}  { allow read: if isOwner(uid); allow write: if false; }
      match /programs/{id}       { allow read: if isOwner(uid); allow write: if false; }
      match /mealPlans/{id}      { allow read: if isOwner(uid); allow write: if false; }

      match /bodyScans/{id} {
        allow read: if isOwner(uid);
        allow create: if false;                     // Functions-only (tied to parse+Storage)
        allow update: if isOwner(uid);               // user corrects extracted values
        allow delete: if false;
      }

      match /activities/{id}     { allow read: if isOwner(uid); allow write: if false; }  // Phase 1, Functions-only (intervals.icu sync)

      // Phase 2 seams
      match /workouts/{id}       { allow read, create, update, delete: if isOwner(uid); }
      match /nutritionDays/{d}   { allow read, create, update, delete: if isOwner(uid); }
      match /checkins/{id}       { allow read: if isOwner(uid); allow write: if false; }
    }

    match /credentials/{uid} { allow read, write: if false; }   // Admin SDK only, always
    match /{document=**}     { allow read, write: if false; }   // default-deny
  }
}
```

```js
// storage.rules
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/hevy/{fileName} {
      allow read, write: if request.auth != null && request.auth.uid == uid
        && request.resource.size < 5 * 1024 * 1024 && fileName.matches('.*\\.csv');
    }
    match /users/{uid}/bodyscans/{fileName} {
      allow read, write: if request.auth != null && request.auth.uid == uid
        && request.resource.size < 10 * 1024 * 1024 && fileName.matches('.*\\.pdf');
    }
    match /{allPaths=**} { allow read, write: if false; }
  }
}
```

`firestore.indexes.json`: let the emulator/console generate the composite indexes needed for `status == "active"` + `orderBy(createdAt, desc)` on `programs`/`mealPlans` — don't hand-author speculatively.

---

## Cloud Functions

All callables use Functions v2 (`onCall`, Admin SDK, automatic ID-token auth). The user-creation hook uses the v1 `functions.auth.user().onCreate` namespace (v2 has no plain equivalent), coexisting fine with v2 callables in the same codebase.

| Function | Trigger | Claude? | Does |
|---|---|---|---|
| `onUserCreate` | Auth `onCreate` (v1) | No | Seeds `users/{uid}` (empty athlete/nutrition shells, `onboarding.step="scan"`), `state/summary` (nulls/false), `credentials/{uid}` (empty shell). |
| `parseBodyScan` | `onCall` | **Yes** | Input: `{scanId}` pointing at an already-uploaded PDF in Storage. Sends the PDF to Claude for structured extraction (weight, body fat %, muscle mass, BMR, visceral fat, posture notes). Writes `bodyScans/{scanId}` with `confirmedByUser:false`. Client then shows extracted values pre-filled for review; on confirm, client `updateDoc`s `bodyScans/{id}` (corrected values + `confirmedByUser:true`) and `users/{uid}.athlete.bodyweight_kg`/`body_fat_pct` directly. |
| `saveIntervalsIcuCredentials` | `onCall` | No | Verifies key via `GET intervals.icu/api/v1/athlete/{athleteId}` (Basic auth), writes `credentials/{uid}.intervalsIcu`, updates `state/summary.integrationsStatus.intervalsIcu`. Never returns the key to the client. **On success, immediately invokes `syncIntervalsActivities`** so the initial data pull happens as part of connecting, not a separate step. |
| `syncIntervalsActivities` | `onCall` | No | Ports `sync-intervals.ps1`'s logic to TypeScript: reads the stored key from `credentials/{uid}`, calls intervals.icu's `activities`/`wellness` endpoints (default last 42 days), writes one `activities/{activityId}` doc per activity plus the latest CTL/ATL/TSB into `state/summary.wellness`, updates `integrationsStatus.intervalsIcu.lastSyncedAt`/`activitiesSynced`. Called automatically after credential save, and re-invocable via a "Sync Now" action on the dashboard. Scheduled/automatic recurring sync is a Phase 2 enhancement — Phase 1 is on-demand only. |
| `parseHevyCsv` | `onCall` | No | Input: `{storagePath}` of an uploaded CSV. Ports `sync-hevy.ps1`'s logic to TypeScript (unit/weight-detection, workout/exercise grouping, set-token parsing) to extract recent lifts, writes them into `users/{uid}.athlete.current_lifts`, updates `state/summary.integrationsStatus.hevy`. |
| `calculateTargets` | `onCall` | No | Pure Mifflin-St Jeor/TDEE/macro function, ported verbatim from `trainer-intake/SKILL.md` (`lib/macros.ts`, unit-tested, reused by Phase 2 check-in later). Writes `targetHistory/{autoId}`, updates `state/summary.currentTargets`. |
| `generateProgram` | `onCall` | **Yes** | System prompt encodes `build-program/SKILL.md` rules (split by days/week, compound-first selection, 10-20 sets/muscle/week, RIR, double progression, deload cadence, injury substitutions). Forces structured JSON via tool-calling, validates server-side, retries once on invalid output, archives prior active program, writes new doc. |
| `generateMealPlan` | `onCall` | **Yes** | Same pattern for `plan-meals/SKILL.md` rules (protein-first, hard allergy/dislike exclusion, hawker-macro estimation, cuisine preferences). Structured JSON, validated, archives prior, writes new doc. |

Free-text profile fields (`injuries_constraints`, `goal`) get interpolated into `generateProgram`/`generateMealPlan` prompts — cap field length server-side and instruct the model to treat profile text as data, not instructions (cheap defense-in-depth against prompt injection at this trust level). Neither function takes client-supplied free-form input beyond "regenerate" — everything comes from the user's own stored profile, matching how the original skills only ever read local files.

---

## Frontend Architecture

**Vanilla JS + Firebase JS SDK (v9+ modular, ESM), no bundler, no framework.** `nutrition.html` already proves this team can hand-roll nontrivial client-side rendering (SVG charts, threshold glyphs) in plain JS at this exact scope; Firebase's modular SDK ships ESM builds off `gstatic.com` that work via `<script type="module">` with zero tooling, same deploy model as today (`firebase deploy --only hosting` on a folder). At 10-50 users and ~6 pages, a framework's benefits don't pay for their complexity tax. Revisit only if Phase 2's logging forms need real interactive state management.

Pages (multi-page, no client router):
- `login.html` — Email/Password + Google Sign-In, redirects based on `onboarding.completed`.
- `onboarding.html` — multi-step wizard:
  1. **Body scan** (optional/skippable) — upload PDF → Storage → `parseBodyScan` → review/edit extracted weight/body-fat inline → confirm.
  2. **Connect your data** (optional/skippable) — intervals.icu key+ID → `saveIntervalsIcuCredentials` (auto-triggers `syncIntervalsActivities` on success, shown as a brief "syncing your recent training..." state); Hevy CSV → Storage → `parseHevyCsv`.
  3. **Your profile** — remaining fields (equipment, schedule, injuries, goals, diet prefs) as fieldsets, direct client `updateDoc` to `users/{uid}`. Weight/body-fat fields pre-filled from step 1 if a scan was uploaded, otherwise manual entry.
  4. **Review & generate** — `calculateTargets`, show the math, then `generateProgram` + `generateMealPlan` with a loading state, redirect to `dashboard.html`.
- `dashboard.html` — replaces the current `index.html` card list: target badges, a **training-load stat-card row (CTL/ATL/TSB)** reusing the exact `status` section pattern already present in today's `program.html`, now fed from `state/summary.wellness` instead of being hand-typed; links to program/meals/profile; "Regenerate"/"Sync Now" buttons; sign-out.
- `program.html` / `meals.html` — same visual shell as today (`.toc` sidebar + scrollspy, `.ex` cards + `.load` tag, `.week` grid, `.pill`/`.callout` classes all carry over as CSS/markup), but rendered from `state/summary.currentProgramId/currentMealPlanId` → Firestore `getDoc`, not hardcoded.
- `profile.html` — reuses the onboarding step-3 form component for viewing/editing, plus a body-scan history view.
- Shared `js/firebase-init.js` (Auth/Firestore/Storage init) and `js/auth-guard.js` (redirect-to-login) on every protected page.
- **CSS consolidation**: extract the currently-duplicated `:root` variables and component classes into one `public/styles/theme.css`, linked everywhere — removes drift risk now that every page is touched anyway.
- `sw.js`/`update.js`/`manifest.webmanifest` — keep the network-first + manual-cache-bump + update-banner pattern; update `sw.js`'s asset list, drop `remote.html`.

---

## Branch & Folder Layout

New branch `feature/multiuser-firebase` in `hj-2t3of5`. `main` untouched.

```
hj-2t3of5/                        (on the branch)
  firebase.json  .firebaserc  firestore.rules  firestore.indexes.json  storage.rules

  functions/
    src/
      index.ts
      lib/macros.ts               # deterministic TDEE/macro math — ports trainer-intake/SKILL.md
      lib/hevyParser.ts           # deterministic CSV parse — ports tools/sync-hevy.ps1
      lib/intervalsClient.ts      # deterministic API client + parse — ports tools/sync-intervals.ps1
      lib/claude.ts               # Anthropic client wrapper + schema-validated JSON extraction
      lib/schemas.ts              # program/mealPlan/bodyScan validators
      auth/onUserCreate.ts
      profile/calculateTargets.ts
      scans/parseBodyScan.ts
      integrations/saveIntervalsIcuCredentials.ts
      integrations/syncIntervalsActivities.ts
      integrations/parseHevyCsv.ts
      generate/generateProgram.ts
      generate/generateMealPlan.ts
    test/

  public/                         # Firebase Hosting root
    login.html  onboarding.html  dashboard.html  program.html  meals.html  profile.html
    styles/theme.css
    js/firebase-init.js  js/auth-guard.js  js/onboarding-wizard.js  js/render-program.js  js/render-meals.js
    sw.js  update.js  manifest.webmanifest
    icon-180.png  icon-512.png  icon-meals-180.png  icon-meals-512.png  robots.txt

  legacy-static/                  # old GH Pages files kept for markup/CSS reference, not deployed
    index.html  program.html  nutrition.html  meals.html  remote.html  firebase-config.js
```

`firebase-config.js`'s existing values feed into `public/js/firebase-init.js` for Auth+Firestore+Storage init (this config is not secret — see below). Firestore region: **`asia-southeast1`**, matching the existing RTDB's region and the user base.

---

## Secrets Handling

1. **Anthropic API key** (one global secret) → Firebase Functions v2 secret via Secret Manager (`firebase functions:secrets:set ANTHROPIC_API_KEY`), bound only to `parseBodyScan`/`generateProgram`/`generateMealPlan`. Never in Firestore, never client-side.
   **Setup note**: this requires a separate account at [console.anthropic.com](https://console.anthropic.com) with its own pay-as-you-go billing. A Claude Pro/Max/Team subscription (claude.ai, or what Claude Code itself might be running on) is a completely different product from the Anthropic API — it does not include API credits or produce an API key usable here. This must be provisioned before Cloud Functions can call Claude.

   **Cost estimate** (Claude Sonnet-tier pricing, ~$3/MTok input / ~$15/MTok output — verify current rates at console.anthropic.com/pricing before launch, as this changes over time). Token counts below are grounded in the actual program/meal-plan/profile content generated earlier in this session, not guesses:

   | Call | Input tokens (~) | Output tokens (~) | Cost/call (~) |
   |---|---|---|---|
   | `parseBodyScan` (2-3 page PDF) | 5,000 | 500 | $0.02 |
   | `generateProgram` (profile + rules → 8-week block) | 3,500 | 3,000 | $0.06 |
   | `generateMealPlan` (profile + rules → swap-list plan) | 3,000 | 2,500 | $0.05 |

   **Onboarding (one-time per new user)**: 1 scan parse + 1 program + 1 meal plan ≈ **$0.14/user**. For 50 new users: ~$7 one-time.

   **Ongoing regeneration** (users hitting "Regenerate" occasionally, not constantly — this is a program/meal swap, not a daily action):
   - Light usage (~1 regen/month/user, 10 users): ~$1/month
   - Moderate usage (~weekly regen, 50 users): ~$20-25/month

   **Bottom line: expect low double-digit dollars per month at most, for the full 10-50 user community at realistic usage patterns** — this is not a cost that should drive architecture decisions at this scale, but budget a small recurring line item and monitor actual usage after launch rather than assuming the estimate holds exactly.
2. **Per-user intervals.icu key** → `credentials/{uid}` Firestore collection, `allow read, write: if false` for every client rule — reachable only via Admin SDK inside Cloud Functions (which always bypasses rules). This is the standard Firebase pattern for per-user secrets; Secret Manager doesn't fit this shape (no per-user query/list ergonomics).
3. **Firebase Web SDK config** (`apiKey`, `authDomain`, etc.) — not a secret by Firebase's design; access control is Auth + Security Rules, not hiding this config. Stays in plain sight in `firebase-init.js`, same as today.

**Standing action, independent of this branch's timeline**: delete the live Realtime Database instance from the Firebase console once `messages`/`remote.html` retires — an open-write, unauthenticated DB is a live liability even if `main` isn't touched by this branch yet. Can happen anytime, doesn't block or depend on Phase 1 build steps.

---

## Build Sequence

Steps 1-8 run entirely against Firebase emulators — zero risk to the live project. Only step 9 touches the real backend, and only via a Hosting preview channel (not production).

0. **Save this plan** into the repo at `hj-2t3of5/.claude/plans/2026-08-02-multiuser-firebase-phase1.md` so it travels with the branch/codebase, not just this local Claude Code session.
1. **Scaffolding**: `firebase init` on the branch (Firestore, Functions/TypeScript, Hosting → `public/`, Storage, Emulators; no Realtime Database). Verify: `firebase emulators:start` boots clean.
2. **Enable Firestore + Auth on the real project** (one-time console action — Firestore doesn't exist yet, only RTDB does; region `asia-southeast1`; enable Email/Password + Google providers). Verify: providers show enabled in console. Nothing else touches the live project yet.
3. **Security rules + automated rules-tests**: write `firestore.rules`/`storage.rules` as above; write tests with `@firebase/rules-unit-testing` asserting unauthenticated access is denied everywhere, user A can never read/write user B's data, and client writes to `state/summary`/`programs`/`mealPlans`/`credentials`/`bodyScans` (create) are all rejected even for the doc's own owner. Verify: `firebase emulators:exec "npm run test:rules"` passes offline. **This automated cross-user-isolation test is non-negotiable** — it's the entire point of moving off the current open rules.
4. **Auth pages + `onUserCreate`**: build `login.html` + `firebase-init.js` + `auth-guard.js` against the Auth emulator. Verify: sign up in emulator UI, confirm `users/{uid}` + `state/summary` + `credentials/{uid}` shells appear automatically.
5. **Onboarding wizard, all four steps**, against emulators. Verify: after completing it, `users/{uid}` matches the schema, `bodyScans`/`credentials` writes are rejected from devtools when attempted directly by the client outside the allowed paths.
6. **`parseBodyScan`, `parseHevyCsv`, `saveIntervalsIcuCredentials` + `syncIntervalsActivities`**: implement all four. Test `parseBodyScan` against the two real Visbody PDFs already available in this session's context (good real fixtures — known expected weight/body-fat/muscle-mass values to check extraction against); test `parseHevyCsv` against a real Hevy export; test the intervals.icu pair against a real API key against the emulator-adjacent live API call (this one can't be fully emulated since it calls a real external service) — verify `activities` docs and `state/summary.wellness` populate correctly and that the auto-trigger-on-save behavior works.
7. **`calculateTargets`**: port `lib/macros.ts`; unit-test with real numbers as regression fixtures (no emulator needed, pure function).
8. **`generateProgram` / `generateMealPlan`**: implement with tool-forced JSON schema output + server-side validation + retry-once. Then build `dashboard.html`, `program.html`, `meals.html`, `profile.html` reading from Firestore, reusing the existing CSS/markup. Verify end-to-end in the emulator: signup → onboarding (incl. scan + Hevy upload) → generate → both pages render; PWA still installs.
9. **Deploy to a Hosting preview channel** on the real project: `firebase deploy --only firestore:rules,firestore:indexes,storage,functions`, then `firebase hosting:channel:deploy preview-phase1 --expires 7d`. Do not touch the live Hosting channel. Smoke-test the preview URL end-to-end on a phone (Add to Home Screen) with a real signup before any production cutover decision.

---

## Verification

- **Emulator Suite** (Auth + Firestore + Functions + Storage) covers steps 3-8 with zero risk to the live project.
- **Cross-user isolation** is an automated test (step 3), not manual spot-checking — this is the core security property this whole build exists to establish.
- **Claude-backed functions** (`parseBodyScan`, `generateProgram`, `generateMealPlan`) split verification into automated + human review, since output is judgment-based, not deterministic:
  - *Automated*: JSON schema validity (enforced pre-write); allergy/foods-to-avoid hard-exclusion (exact string match, fully mechanical); macro totals within ~5-10% of target; program days-per-week matches profile; body-scan extraction sanity bounds (e.g. body_fat_pct between 3-60).
  - *Human review*: run `generateProgram`/`generateMealPlan` against a couple of realistic seeded profiles with real constraints (e.g. an injury note, allergy, specific equipment list) and eyeball exercise substitutions and meal realism against a short rubric; run `parseBodyScan` against the two real Visbody PDFs from this session and confirm extracted numbers match what's legible on the actual report.
- Keep Claude calls behind a flag so emulator/CI runs can stub responses for fast iteration, with a required "real mode" pass before considering any of the three functions done.

---

## Explicitly Out of Scope (Phase 2)

Workout logging (structured form → `workouts` collection), macro tracking + the Scoreboard (deterministic 14-day/7-day-avg glyph math, fully specified and ready to port from `track-macros/SKILL.md` once needed), check-ins (LLM-backed trend analysis over logged data, reusing `lib/macros.ts` for any recalculation and `activities`/wellness data already flowing in from Phase 1's intervals.icu sync), and **scheduled/automatic recurring** intervals.icu re-sync (Phase 1 ships on-demand sync only — triggered at onboarding and via a manual "Sync Now" action). The schema above already reserves `workouts`, `nutritionDays`, `checkins`, and the `targetHistory.source: "checkin"` field so none of this requires a schema rework — just new Cloud Functions and pages built against collections that already exist in the rules. `activities` is populated starting in Phase 1, not reserved.

Also out of scope: migrating the two real users' existing local data, rebuilding the messages/partner-communication feature, and any decision about `main`/GitHub Pages' long-term fate (left running as-is; cutover is a separate future call).
