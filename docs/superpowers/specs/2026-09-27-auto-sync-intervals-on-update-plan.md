# Auto-Sync intervals.icu on "Update My Plan"

**Date**: 2026-09-27
**Status**: Approved, ready for implementation
**Scope**: Trigger an intervals.icu activity sync automatically when the user taps "Update my plan" on the check-in page, so program generation grounds on fresh cardio data without a separate manual "Sync Now" step. No other trigger point (dashboard, onboarding background generation) is touched.

## Motivation

`HANDOFF-check-in-and-plan-updates.md`'s open-work list (section 6, "Next up: better run data from intervals.icu") names this as priority 1: *"Auto-sync intervals.icu when 'Update my plan' is tapped. Today it only syncs on 'Sync now'."* Right now, a user who hasn't separately pressed "Sync Now" gets a plan update grounded on whatever intervals.icu data happened to be synced last — which could be stale by however long it's been since their last manual sync, undermining the point of the HR-zone/interval-summary work that just shipped (2026-09-27-run-hr-zone-interval-context).

## Where this hooks in

`functions/src/generate/generateProgram.ts` exports exactly one client-callable entry point, `generateProgram` (an `onCall` handler). Client-side, it has exactly one caller: `public/js/checkin.js`'s `regenBtn` click handler ("Update my plan"). A separate, unrelated path — `onProgramGenerationRequested.ts`, a background Firestore trigger — handles the *initial* onboarding generation asynchronously and calls the shared `runGenerateProgram(uid, opts)` function directly, never through the `generateProgram` onCall. So hooking the sync into the `generateProgram` onCall handler itself (not into `runGenerateProgram`) scopes this exactly to "user tapped Update my plan," with zero risk of touching the onboarding background path.

## Change

In `functions/src/generate/generateProgram.ts`'s `generateProgram` onCall handler, immediately after the `request.auth` check and before calling `runGenerateProgram`:

1. Read `credentials/{uid}.intervalsIcu.accessToken` from Firestore.
2. If no token is stored (intervals.icu never connected), skip straight to `runGenerateProgram` — no wasted call, no error.
3. If a token exists, call the existing `syncIntervalsActivitiesForUser(uid, accessToken)` (from `lib/intervalsClient.ts` — the same function `syncIntervalsActivities.ts`'s manual "Sync Now" callable already uses) inside a try/catch.
   - On success: proceed to `runGenerateProgram` as normal. Nothing else changes.
   - On failure: soft-fail, mirroring `syncIntervalsActivities.ts`'s existing error handling exactly — update `users/{uid}/state/summary.integrationsStatus.intervalsIcu.lastError` with the error message, and additionally set `connected: false` if the failure looks like an auth error (message contains `"(401)"` or `"(403)"`, same substring check already used in `syncIntervalsActivities.ts`). Then proceed to `runGenerateProgram` regardless — a sync failure never blocks plan generation.

No client-side change: `checkin.js`'s `regenBtn` handler is untouched — it already just calls `generateProgram` and renders the result. The sync becomes invisible extra work the server does before generating, per the "silent" UX decision below.

## UX decision

The "Update my plan" success message stays exactly as it is today (no "synced N activities" note added). The sync is invisible plumbing, not a separate user-facing step — consistent with the existing UX, where the user asked for a plan update and got one; whether intervals.icu happened to have new data first is an implementation detail.

## Error handling

Soft-fail only, as specified above. This introduces no new failure mode: worst case, a sync failure leaves `runGenerateProgram` grounding on the same (already-there) data it would have used if this feature didn't exist at all — never worse than today's behavior, and typically better since most calls will pull fresh data first.

## Testing

`generateProgram.ts`'s `generateProgram` onCall wrapper is a thin, currently-untested wrapper around the already-tested `runGenerateProgram` (covered by `test/generateProgram.integration.test.ts`, LLM mocked). The new code added here calls `syncIntervalsActivitiesForUser`, which is itself not independently unit tested (real intervals.icu API dependency, same convention already established for the rest of `lib/intervalsClient.ts` — see the prior HR-zone-context spec's Testing section). No new unit tests are planned for this change; verification is live: deploy, tap "Update my plan" on the real check-in page, and confirm via Cloud Functions logs and/or the Firestore `integrationsStatus.intervalsIcu.lastSyncedAt` timestamp that a sync ran immediately before generation.
