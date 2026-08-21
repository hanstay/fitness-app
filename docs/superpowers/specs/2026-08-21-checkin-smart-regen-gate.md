# Check-in: fold intervals.icu sync into "Update my plan", gate on new data

**Date**: 2026-08-21
**Status**: Approved, ready for implementation
**Scope**: `public/checkin.html` / `public/js/checkin.js` only. No backend changes — `generateProgram` and `syncIntervalsActivities` are called exactly as they are today, just from a different place in the frontend flow. The dashboard's "Regenerate" button (`dashboard.html`) is untouched and remains an unconditional manual override.

## Motivation

Today the check-in page has three independent controls: "Sync now" (intervals.icu), "Upload & analyze" (Hevy), and "Update my plan". Nothing forces them to run in the right order — a user can click "Update my plan" without ever syncing intervals.icu first, in which case `generateProgram` regenerates against stale `wellness`/`activities` data (it only reads whatever is already sitting in `state/summary`/`users/{uid}/activities`, see `functions/src/generate/generateProgram.ts:232-244`). The standalone "Sync now" button is redundant busywork the user has to remember to press.

Separately, "Update my plan" currently runs unconditionally — even when nothing has changed since the last check-in (no new Hevy sessions, no new intervals.icu data, no profile edits), which burns an LLM call for a no-op regen.

## Decision: what counts as "new data"

`runGenerateProgram` already has its own authoritative signal for this — `needsFullRegen`/`structuralChanged` in `functions/src/lib/programDecisions.ts` — but that only decides *full vs. incremental*, it doesn't block generation when nothing changed at all, and Hevy/intervals freshness isn't part of it (see the "Data associations" note this spec was scoped from). Three independent signals make a check-in worth running:

1. **Profile changed** — goal, training days/week, session length, preferred split, equipment, events, or fixed sessions differ from the active program's `profileSnapshot`. Mirrors the same field set `structuralChanged` checks server-side, computed client-side against data the page already has read access to (`firestore.rules:15` allows owner read on `programs`).
2. **New Hevy data** — `state/summary.integrationsStatus.hevy.parsedAt` is newer than the active program's `createdAt`.
3. **Fresh intervals.icu sync** — the sync triggered by this click succeeded (connected + `syncIntervalsActivities` resolved without throwing).

If none of the three hold, generating would just reproduce the same plan — block the call and tell the user why, pointing them at what to fix or at the dashboard's "Regenerate" as an explicit force-anyway escape hatch (that button stays available and ungated everywhere else in the app).

## Flow

`regenBtn` click handler (replacing `checkin.js:248-265`):

1. Clear messages, disable the button (existing `withButtonBusy` pattern).
2. **If intervals.icu is connected** (`summary.integrationsStatus.intervalsIcu.connected`): call `syncIntervalsActivities` first. Best-effort — catch and record failure, don't throw, don't block on it. (This replaces the standalone "Sync now" button; see below.)
3. Reload `summary`; read the active program doc (`users/{uid}/programs` where `status == "active"`) and the athlete profile (`users/{uid}`).
4. Compute the three gate signals above.
5. **None hold** → don't call `generateProgram`. Show a status message tailored to the actual blocker (see "Messages" below) and, if intervals.icu isn't connected, expand/scroll to `icuSection` (reusing the existing `expandSection` helper) so the fix is one click away.
6. **At least one holds** → call `generateProgram` exactly as today, render the result exactly as today.

## Frontend changes (`public`)

- **Removed**: `#icuSyncBtn` ("Sync now") from `checkin.html`'s `icuConnected` block (`checkin.html:73-75`) and its click handler in `checkin.js` (`checkin.js:203-215`). Syncing now only happens as step 2 of the "Update my plan" flow above — there's no longer a reason for a separate manual trigger.
- **Changed**: `regenBtn` handler (`checkin.js:248-265`) grows the sync-then-gate-then-generate sequence described above. `icuStatus`/`icuLastSync`/wellness stat rendering (`renderIcuState`, `renderWellness`) stay as-is and just get called with fresher data before the gate check.
- **New helper** in `checkin.js`: a small `checkRegenReadiness({ summary, athlete, activeProgram })` function implementing the three-signal check — pure, no I/O, easy to eyeball-verify against `structuralChanged`'s field list.

## Messages (blocking case)

Match the actual blocker so the user knows what to do next, not just "nothing to do":

- **Not connected to intervals.icu AND no Hevy data at all**: "Nothing new to update your plan with — connect intervals.icu or import a Hevy CSV below. (Or use Regenerate on your dashboard to force a fresh plan.)" → expand `icuSection`.
- **Connected but this sync failed, and no new Hevy data**: "Training load didn't sync (`<error>`) and there's no new Hevy data either — nothing new to base an update on. Fix the connection above, import fresh Hevy data, or use Regenerate on your dashboard."
- **Everything nominally working, just nothing new** (e.g. Hevy connected but no sessions since the last plan, profile unchanged, intervals synced but nothing changed): "No new data since your last update — log a session, or use Regenerate on your dashboard to force a fresh plan anyway."

## Explicitly out of scope

- No new Cloud Function. Both `syncIntervalsActivities` and `generateProgram` are called by name exactly as today; the gate is a client-side pre-check, not a server-side precondition — `runGenerateProgram` remains reachable unconditionally (dashboard's Regenerate depends on that).
- No change to `needsFullRegen`/`structuralChanged` or the full-vs-incremental decision — this spec only decides *whether to call `generateProgram` at all* from the check-in page, not what kind of regen it performs once called.
- No settings page. The existing `icuSection` connect UI on `checkin.html` is reused in place (expand + scroll) rather than redirecting anywhere.
