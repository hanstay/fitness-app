# Run HR-Zone & Interval Context for Generation

**Date**: 2026-09-27
**Status**: Approved, ready for implementation
**Scope**: Surface HR-zone intensity and interval structure for intervals.icu activities into the program-generation prompt, using data already returned by the existing `ACTIVITY:READ,WELLNESS:READ` sync. No new OAuth scope, no reconnect, no new sync call sites.

## Motivation

The handoff for this branch (`HANDOFF-check-in-and-plan-updates.md`, "Next up: better run data from intervals.icu") starts from "the model only sees per-activity averages, and it doesn't know the athlete's zones," and proposes fetching a new `sport-settings` endpoint (requiring the `SETTINGS:READ` OAuth scope and a one-time reconnect) to get HR zones, pace zones, and threshold pace.

Investigating the real data (via the Firestore console, against the live `fitness-app-47a06` project) found:

- **HR zone boundaries (`icu_hr_zones`) and LTHR are already present** on every synced activity's `raw` field, with no extra scope — intervals.icu auto-estimates these from HR data.
- **`interval_summary`** — a human-readable digest of interval structure (e.g. `["5x 7m39s 148bpm", "1x 2m30s 155bpm"]`) — is **also already present**, again with no extra scope.
- **Pace zones and threshold pace are null** on every activity checked, including a real run. This isn't a scope gap — it's because the athlete hasn't (yet) entered a threshold pace in intervals.icu's Settings → Sport Settings → Run page, which is a manual, unset-by-default field with no auto-calculate option. Chasing pace zones would mean either asking the athlete to maintain a number in a third-party setting, or building our own pace-threshold estimator — both are more machinery than the immediate goal needs.

So the actual gap isn't missing data — it's that already-synced HR zone and interval data sit unused in `raw` and never reach the prompt. This spec closes that gap. Threshold pace / pace zones are explicitly out of scope for now (revisit only if HR-zone context turns out to be insufficient for judging run intensity in practice).

## Data flow (context)

`groundingData.ts::gatherGroundingData()` reads `users/{uid}/activities` and builds `activitySummary` — one line per intervals.icu activity (date, type, duration, distance, pace, avg HR, training load). This, plus the Hevy-derived `trainingLogBlock`/`exerciseVocabulary`, gets assembled into one flat `profileText` string in `generateProgram.ts` and sent as-is to the LLM. `groupProgram.ts`'s Stage B (per-member) path calls the same `gatherGroundingData()`. This spec only changes what goes into `activitySummary`'s per-line content — nothing about the assembly/prompt structure changes.

## Backend changes (`functions/src`)

- **`lib/intervalsClient.ts`**:
  - Extend the `IntervalsActivity` interface (currently a narrow typed subset of the API response) with `icu_hr_zones?: number[]` and `interval_summary?: string[]`.
  - In `syncIntervalsActivitiesForUser`'s `batch.set()` write, add two new top-level fields alongside the existing curated ones (`avg_hr`, `pace`, etc.): `hrZones: a.icu_hr_zones ?? null` and `intervalSummary: a.interval_summary ?? null`. (The full response is already stored under `raw`; this promotes the two fields we now use out of `raw` for the formatting layer to consume directly, matching how every other consumed field is already handled.)

- **`lib/trainingLog.ts`** (pure, unit-tested):
  - Add `hrZoneLabel(avgHr: number | null | undefined, hrZones: number[] | null | undefined): string | null` — `hrZones` is intervals.icu's array of per-zone *upper* bounds (e.g. `[157, 167, 176, 186, 191, 197, 206]` for Z1..Z7 — confirmed against a real activity). The label is `"Z${n}"` where `n` (1-indexed) is the first zone whose upper bound is `>= avgHr`; values above the last boundary label as the final zone (`Z7`). Returns `null` if `avgHr` or `hrZones` is missing/empty.

- **`generate/groundingData.ts`**:
  - Extend the `ActivityDoc` interface with `hrZones?: number[] | null` and `intervalSummary?: string[] | null`.
  - In the `activitySummary` line-building loop, call `hrZoneLabel(a.avg_hr, a.hrZones)` and append it next to the existing `avg HR ${a.avg_hr}` bit (e.g. `avg HR 172 (Z3)`) when present.
  - When `a.intervalSummary?.length`, append `intervals: 5x 7m39s@148bpm, 1x 2m30s@155bpm` (joined) to the line.
  - Add one legend line above the activity list — e.g. `HR zones (bpm): Z1 <157, Z2 157-176, ...` — derived from the most recent activity in the batch that has `hrZones`, so the model has the boundary context without repeating it on every line.

## Error handling

All new fields are optional and nullable. Activities missing `hrZones`/`intervalSummary` (older syncs from before this change, or non-running/non-HR activity types) simply omit the zone label / interval bits for that line — same graceful-degradation pattern already used for `pace` and `avg_hr` (`a.pace && bits.push(...)`). No new failure modes: nothing here can fail a sync or a generation that would otherwise succeed.

## Testing

- Unit tests for `hrZoneLabel` in `test/trainingLog.test.ts`: value below the first boundary (Z1), value above the last boundary (Z7), a mid-range value, missing/empty `hrZones`, missing `avgHr`.
- `groundingData.ts` and `intervalsClient.ts` stay Firestore/live-API-dependent and are not unit tested today (per the existing pattern noted in the handoff — "how well the model follows the new prompt instructions has only been verified by real use"). Verification here is: deploy, confirm a re-sync (`Sync Now` or a future connect) populates `hrZones`/`intervalSummary` on a real activity doc via the Firestore console, and confirm the assembled `activitySummary` block reads correctly (e.g. via a manual "Update my plan" run or a temporary log line, whichever is less invasive at implementation time).
