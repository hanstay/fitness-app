# Run HR-Zone & Interval Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface intervals.icu's already-synced HR-zone boundaries and interval-structure digest in the program-generation prompt, so the model can judge run/cardio intensity instead of seeing only a raw average HR number.

**Architecture:** Two already-fetched-but-unused fields (`icu_hr_zones`, `interval_summary`) get promoted from the intervals.icu API response into top-level Firestore fields on each synced activity (same pattern as the existing `avg_hr`/`pace` fields). A new pure formatting function converts an activity's average HR + zone boundaries into a `"Z3"`-style label. The prompt-building code that already renders one line per activity gets that label and the interval digest appended.

**Tech Stack:** TypeScript, Firebase Cloud Functions (Node 22, 2nd gen), Firestore, Vitest.

## Global Constraints

- No new OAuth scope, no reconnect flow, no new sync call sites — everything rides the existing `ACTIVITY:READ,WELLNESS:READ` sync (`syncIntervalsActivitiesForUser`, called from both "connect" and "Sync Now").
- `intervalsClient.ts` and `groundingData.ts` are not unit tested (real Firestore/API dependencies) — verify those by build + live check, not new mocked tests, matching existing project convention.
- `trainingLog.ts` is pure and unit-tested (`test/trainingLog.test.ts`) — any new pure logic there needs matching unit tests.
- Deploy command for this project: `npx firebase-tools deploy --only functions` (from repo root, with `$env:FUNCTIONS_DISCOVERY_TIMEOUT=60` set first — see `HANDOFF-check-in-and-plan-updates.md`).

---

### Task 1: `hrZoneLabel` pure function

**Files:**
- Modify: `functions/src/lib/trainingLog.ts` (append new function at end of file, after `formatPrescription`)
- Test: `functions/test/trainingLog.test.ts` (append new `describe` block at end of file)

**Interfaces:**
- Produces: `hrZoneLabel(avgHr: number | null | undefined, hrZones: number[] | null | undefined): string | null`, exported from `functions/src/lib/trainingLog.ts`. `hrZones` is intervals.icu's array of per-zone *upper* bounds in bpm (e.g. `[157, 167, 176, 186, 191, 197, 206]` for Z1..Z7). Returns `"Z${n}"` where `n` (1-indexed) is the first zone whose upper bound is `>= avgHr`; values above the last boundary label as the final zone. Returns `null` if `avgHr` or `hrZones` is missing/empty.

- [ ] **Step 1: Write the failing tests**

Append to `functions/test/trainingLog.test.ts`:

```typescript
describe("hrZoneLabel", () => {
  const zones = [157, 167, 176, 186, 191, 197, 206];

  it.each([
    [150, "Z1"],
    [157, "Z1"],
    [158, "Z2"],
    [167, "Z2"],
    [172, "Z3"],
    [206, "Z7"],
    [220, "Z7"],
  ])("labels avg HR %d as %s", (hr, label) => {
    expect(hrZoneLabel(hr, zones)).toBe(label);
  });

  it("returns null when hrZones is missing or empty", () => {
    expect(hrZoneLabel(160, null)).toBeNull();
    expect(hrZoneLabel(160, undefined)).toBeNull();
    expect(hrZoneLabel(160, [])).toBeNull();
  });

  it("returns null when avgHr is missing", () => {
    expect(hrZoneLabel(null, zones)).toBeNull();
    expect(hrZoneLabel(undefined, zones)).toBeNull();
  });
});
```

Also update the import at the top of the file to include `hrZoneLabel`:

```typescript
import {
  exercisesMatch, formatRecentLog, weeklySessionCounts, formatBestSetsByMonth,
  buildExerciseVocabulary, formatPrescription, hrZoneLabel,
} from "../src/lib/trainingLog";
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `functions/`): `npx vitest run test/trainingLog.test.ts`
Expected: FAIL — `hrZoneLabel` is not exported from `../src/lib/trainingLog`.

- [ ] **Step 3: Write the implementation**

Append to `functions/src/lib/trainingLog.ts` (after the final `}` that closes `formatPrescription`):

```typescript

// ---------------------------------------------------------------------------
// Cardio activity formatting (intervals.icu)
// ---------------------------------------------------------------------------

/**
 * Labels an activity's average HR against the athlete's HR zone boundaries
 * (intervals.icu's per-zone upper bounds, e.g. [157,167,176,186,191,197,206]
 * for Z1..Z7). Returns null if either input is missing — callers should omit
 * the label rather than show a wrong one.
 */
export function hrZoneLabel(avgHr: number | null | undefined, hrZones: number[] | null | undefined): string | null {
  if (avgHr == null || !hrZones || hrZones.length === 0) return null;
  const idx = hrZones.findIndex((upperBound) => avgHr <= upperBound);
  const zone = idx === -1 ? hrZones.length : idx + 1;
  return `Z${zone}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/trainingLog.test.ts`
Expected: PASS (all tests in the file, including the new `hrZoneLabel` block).

- [ ] **Step 5: Commit**

```bash
git add functions/src/lib/trainingLog.ts functions/test/trainingLog.test.ts
git commit -m "Add hrZoneLabel for labeling activity avg HR against zone boundaries"
```

---

### Task 2: Persist `hrZones` and `intervalSummary` on sync

**Files:**
- Modify: `functions/src/lib/intervalsClient.ts:14-24` (interface), `:88-102` (batch.set write)

**Interfaces:**
- Consumes: nothing new (pure Firestore-write addition to the existing `syncIntervalsActivitiesForUser` function).
- Produces: two new fields on every doc in `users/{uid}/activities`: `hrZones: number[] | null` and `intervalSummary: string[] | null`, populated from the intervals.icu activities-list response's `icu_hr_zones` / `interval_summary` fields (confirmed present in the live API response — see `docs/superpowers/specs/2026-09-27-run-hr-zone-interval-context.md`). Task 3 reads these two fields.

- [ ] **Step 1: Extend the `IntervalsActivity` interface**

In `functions/src/lib/intervalsClient.ts`, find:

```typescript
interface IntervalsActivity {
  id: string | number;
  start_date_local: string;
  type?: string;
  name?: string;
  distance?: number;
  moving_time?: number;
  average_speed?: number;
  average_heartrate?: number;
  icu_training_load?: number;
}
```

Replace with:

```typescript
interface IntervalsActivity {
  id: string | number;
  start_date_local: string;
  type?: string;
  name?: string;
  distance?: number;
  moving_time?: number;
  average_speed?: number;
  average_heartrate?: number;
  icu_training_load?: number;
  icu_hr_zones?: number[];
  interval_summary?: string[];
}
```

- [ ] **Step 2: Write the two new fields in the sync write**

In the same file, find the `batch.set(ref, {...})` call inside the `for (const a of activities)` loop:

```typescript
    batch.set(ref, {
      date: a.start_date_local?.slice(0, 10) ?? null,
      type,
      name: a.name ?? null,
      distance_km: a.distance ? Math.round((a.distance / 1000) * 100) / 100 : null,
      duration_s: a.moving_time ?? null,
      pace: formatPace(a.average_speed, type),
      avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      training_load: a.icu_training_load ?? null,
      ctl: wellness?.ctl ?? null,
      atl: wellness?.atl ?? null,
      tsb: wellness?.tsb ?? null,
      syncedAt: FieldValue.serverTimestamp(),
      raw: a,
    });
```

Replace with:

```typescript
    batch.set(ref, {
      date: a.start_date_local?.slice(0, 10) ?? null,
      type,
      name: a.name ?? null,
      distance_km: a.distance ? Math.round((a.distance / 1000) * 100) / 100 : null,
      duration_s: a.moving_time ?? null,
      pace: formatPace(a.average_speed, type),
      avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      training_load: a.icu_training_load ?? null,
      hrZones: a.icu_hr_zones ?? null,
      intervalSummary: a.interval_summary ?? null,
      ctl: wellness?.ctl ?? null,
      atl: wellness?.atl ?? null,
      tsb: wellness?.tsb ?? null,
      syncedAt: FieldValue.serverTimestamp(),
      raw: a,
    });
```

- [ ] **Step 3: Type-check**

Run (from `functions/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add functions/src/lib/intervalsClient.ts
git commit -m "Persist HR zone boundaries and interval summary on activity sync"
```

---

### Task 3: Wire zone label + interval summary into the generation prompt

**Files:**
- Modify: `functions/src/generate/groundingData.ts:12-15` (import), `:17-26` (`ActivityDoc` interface), `:130-145` (activity summary building)

**Interfaces:**
- Consumes: `hrZoneLabel` from Task 1 (`../lib/trainingLog`); `hrZones`/`intervalSummary` fields from Task 2 (present on `ActivityDoc` docs read from Firestore).
- Produces: `activitySummary` (already an existing field of the `GroundingData` return type — no signature change) now includes a one-time HR-zone legend line and, per activity, a zone label next to avg HR and an `intervals: ...` bit when interval data exists.

- [ ] **Step 1: Add the import**

In `functions/src/generate/groundingData.ts`, find:

```typescript
import {
  formatRecentLog, formatBestSetsByMonth, weeklySessionCounts,
  buildExerciseVocabulary, formatExerciseVocabulary, formatPrescription, PrescriptionProgram,
} from "../lib/trainingLog";
```

Replace with:

```typescript
import {
  formatRecentLog, formatBestSetsByMonth, weeklySessionCounts,
  buildExerciseVocabulary, formatExerciseVocabulary, formatPrescription, PrescriptionProgram,
  hrZoneLabel,
} from "../lib/trainingLog";
```

- [ ] **Step 2: Extend `ActivityDoc`**

Find:

```typescript
export interface ActivityDoc {
  date?: string | null;
  type?: string;
  name?: string | null;
  distance_km?: number | null;
  pace?: string | null;
  duration_s?: number | null;
  avg_hr?: number | null;
  training_load?: number | null;
}
```

Replace with:

```typescript
export interface ActivityDoc {
  date?: string | null;
  type?: string;
  name?: string | null;
  distance_km?: number | null;
  pace?: string | null;
  duration_s?: number | null;
  avg_hr?: number | null;
  training_load?: number | null;
  hrZones?: number[] | null;
  intervalSummary?: string[] | null;
}
```

- [ ] **Step 3: Add the legend-formatting helper**

Add this function above `gatherGroundingData` (e.g. directly below the `daysBetween` function):

```typescript
/** "Z1 0-157, Z2 158-167, ..." — the athlete's HR zone boundaries, shown once above the activity list. */
function formatHrZoneLegend(hrZones: number[]): string {
  const ranges = hrZones.map((upper, i) => {
    const lower = i === 0 ? 0 : hrZones[i - 1] + 1;
    const isLast = i === hrZones.length - 1;
    return `Z${i + 1} ${lower}-${upper}${isLast ? "+" : ""}`;
  });
  return `HR zones (bpm): ${ranges.join(", ")}`;
}
```

- [ ] **Step 4: Rewrite the activity summary block**

Find:

```typescript
  const activities: ActivityDoc[] = activitiesSnap
    ? activitiesSnap.docs.map((d) => d.data() as ActivityDoc).filter((a) => !a.date || a.date >= logSince)
    : [];
  const activitySummary = activities.length
    ? activities
        .map((a) => {
          const bits = [a.date, a.type, a.name && a.name !== a.type ? `"${a.name}"` : null];
          if (a.duration_s) bits.push(`${Math.round(a.duration_s / 60)} min`);
          if (a.distance_km) bits.push(`${a.distance_km}km`);
          if (a.pace) bits.push(a.pace);
          if (a.avg_hr) bits.push(`avg HR ${a.avg_hr}`);
          if (a.training_load) bits.push(`load ${a.training_load}`);
          return `- ${bits.filter(Boolean).join(" · ")}`;
        })
        .join("\n")
    : `none in the last ${LOG_DAYS} days`;
```

Replace with:

```typescript
  const activities: ActivityDoc[] = activitiesSnap
    ? activitiesSnap.docs.map((d) => d.data() as ActivityDoc).filter((a) => !a.date || a.date >= logSince)
    : [];
  const hrZoneLegend = activities.find((a) => a.hrZones && a.hrZones.length > 0)?.hrZones ?? null;
  const activityLines = activities.map((a) => {
    const bits = [a.date, a.type, a.name && a.name !== a.type ? `"${a.name}"` : null];
    if (a.duration_s) bits.push(`${Math.round(a.duration_s / 60)} min`);
    if (a.distance_km) bits.push(`${a.distance_km}km`);
    if (a.pace) bits.push(a.pace);
    if (a.avg_hr) {
      const zone = hrZoneLabel(a.avg_hr, a.hrZones);
      bits.push(`avg HR ${a.avg_hr}${zone ? ` (${zone})` : ""}`);
    }
    if (a.training_load) bits.push(`load ${a.training_load}`);
    if (a.intervalSummary?.length) bits.push(`intervals: ${a.intervalSummary.join(", ")}`);
    return `- ${bits.filter(Boolean).join(" · ")}`;
  });
  const activitySummary = activities.length
    ? [...(hrZoneLegend ? [formatHrZoneLegend(hrZoneLegend), ""] : []), ...activityLines].join("\n")
    : `none in the last ${LOG_DAYS} days`;
```

- [ ] **Step 5: Type-check and run the full unit suite**

Run (from `functions/`): `npx tsc --noEmit && npx vitest run --exclude "**/test/rules.test.ts" --exclude "**/*.integration.test.ts"`
Expected: no type errors; all existing unit tests still pass (this task doesn't add new unit tests — `groundingData.ts` is Firestore-dependent and stays covered by live verification, per Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add functions/src/generate/groundingData.ts
git commit -m "Show HR zone and interval structure in the activity log the model sees"
```

---

### Task 4: Deploy and verify against real data

**Files:** none (deploy + manual verification only)

**Interfaces:**
- Consumes: the deployed `syncIntervalsActivities` and `generateProgram`/`onProgramGenerationRequested` functions (unchanged exports, changed internals from Tasks 2–3).

- [ ] **Step 1: Deploy functions**

Run (from repo root):

```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT=60
npx firebase-tools deploy --only functions
```

Expected: `Deploy complete!`, no errors. (Only `functions` needs deploying — this plan doesn't touch anything under `public/`.)

- [ ] **Step 2: Trigger a re-sync against real intervals.icu data**

In the deployed app (`https://fitness-app-47a06.web.app/checkin.html`, signed in as the user whose intervals.icu is already connected), click the "Sync Now" button in the intervals.icu section (`id="icuSyncBtn"` in `public/js/checkin.js`). Expected: a "Synced N activities" status message, no error.

- [ ] **Step 3: Confirm the new fields landed in Firestore**

In the Firebase console (`https://console.firebase.google.com/project/fitness-app-47a06/firestore/databases/-default-/data`), open a recently-synced running activity under `users/{uid}/activities/{id}` (a doc whose `type` is `"Run"` and `date` is today's sync date). Confirm the document now has top-level `hrZones` (a populated array, e.g. `[157, 167, 176, 186, 191, 197, 206]`) and, if that particular run had intervals, `intervalSummary` (a populated array of strings). A non-running activity (e.g. `"WeightTraining"`) is expected to have `hrZones` populated (HR zones apply to any activity type) but `intervalSummary` will usually be `null`.

- [ ] **Step 4: Confirm the prompt block reads correctly**

This step has no automated check (per Global Constraints, `groundingData.ts` is verified live). Options, in order of preference:
  1. If there's a pending check-in or "Update my plan" action to trigger anyway, run it and inspect the Cloud Functions logs (`https://console.firebase.google.com/project/fitness-app-47a06/functions/logs`, filter to `generateProgram` or `onProgramGenerationRequested`) for the assembled `profileText` — confirm the `Recent activities` section now shows a `HR zones (bpm): ...` legend line and per-activity `(Z3)`-style labels / `intervals: ...` bits.
  2. Otherwise, treat Steps 1–3 as sufficient verification for this pass (the data is confirmed correct and reaching Firestore; the prompt-assembly code was covered by Task 3's type-check) and note in the handoff that the next real generation should be spot-checked.

No commit for this task (no code changes).
