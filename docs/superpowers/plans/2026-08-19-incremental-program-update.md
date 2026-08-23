# Incremental Program Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the incremental program-update Claude call from truncating (`maxTokens` too low for its output shape) and make it emit only the days it's actually changing instead of the whole week, cutting typical latency/cost.

**Architecture:** A new pure `mergeIncrementalSessions` helper in `functions/src/lib/programMerge.ts` merges the model's (now sparse) `sessions` output with the athlete's existing sessions, keyed by `day`. `programUpdateSchema` is relaxed to allow an empty/partial `sessions` array, the incremental prompt is told explicitly that omission means "unchanged," and the call's `maxTokens` budget is raised to match the structurally equivalent full-regen schedule call.

**Tech Stack:** TypeScript, Zod, Vitest, Firebase Cloud Functions, Anthropic SDK.

## Global Constraints

- Follow the existing pattern: pure logic lives in `functions/src/lib/*.ts` with a matching `functions/test/*.test.ts` (see `lib/programDecisions.ts` / `test/programDecisions.test.ts`).
- No new dependencies.
- Full-regen path (`programOverviewSchema`/`programScheduleSchema` and their merge) is out of scope — do not touch it.
- Default to no code comments; only add one where a non-obvious constraint needs explaining (e.g. why the merge doesn't cross-reference `weeklyStructure`).
- Spec: `docs/superpowers/specs/2026-08-19-incremental-program-update-design.md` — every task below implements a section of it.

---

### Task 1: Relax `programUpdateSchema` and export the session type

**Files:**
- Modify: `functions/src/lib/schemas.ts:144` (export `sessionSchema`), `:329-356` (`programUpdateSchema` + `programUpdateJsonSchema`)

**Interfaces:**
- Produces: `export const sessionSchema` (was unexported `const`), `export type SessionOutput = z.infer<typeof sessionSchema>` — consumed by Task 2's `programMerge.ts` and its test.
- Produces: `programUpdateSchema.sessions` now `z.array(sessionSchema).max(10)` (no `.min(1)`) — an empty array is valid.

This task has no new pure-logic behavior to unit-test (it's a type/schema relaxation), so verification is a clean TypeScript build.

- [ ] **Step 1: Export `sessionSchema` and add `SessionOutput` type**

In `functions/src/lib/schemas.ts`, change:

```ts
const sessionSchema = z.object({
  day: z.string(),
  label: z.string(),
  focus_note: z.string().nullable(),
  exercises: z.array(exerciseSchema).min(1).max(14),
});
```

to:

```ts
export const sessionSchema = z.object({
  day: z.string(),
  label: z.string(),
  focus_note: z.string().nullable(),
  exercises: z.array(exerciseSchema).min(1).max(14),
});
export type SessionOutput = z.infer<typeof sessionSchema>;
```

- [ ] **Step 2: Relax `programUpdateSchema.sessions` and document the diff contract in the tool schema**

Change:

```ts
export const programUpdateSchema = z.object({
  currentState: currentStateSchema,
  weeklyStructure: z.array(weeklyDaySchema),
  sessions: z.array(sessionSchema).min(1).max(10),
  changeSummary: z.array(z.string()),
  coachNotes: z.string().nullable(),
  nutritionNote: z.string().nullable(),
  running: runningSchema,
});
```

to:

```ts
export const programUpdateSchema = z.object({
  currentState: currentStateSchema,
  weeklyStructure: z.array(weeklyDaySchema),
  sessions: z.array(sessionSchema).max(10),
  changeSummary: z.array(z.string()),
  coachNotes: z.string().nullable(),
  nutritionNote: z.string().nullable(),
  running: runningSchema,
});
```

Then in `programUpdateJsonSchema`, change:

```ts
    sessions: { type: "array", items: sessionJsonSchema },
```

(the one inside `programUpdateJsonSchema`, not `programScheduleJsonSchema`'s) to:

```ts
    sessions: {
      type: "array",
      items: sessionJsonSchema,
      description: "Only include an entry for a day whose session you are actually changing. Omit any day whose session should stay exactly as-is in the existing week — it will be carried forward automatically, so do not restate it. May be empty if nothing should change. A day new to the schedule (not present in the existing week) must be included in full, since there is nothing existing to carry forward for it.",
    },
```

- [ ] **Step 3: Build to verify no type errors**

Run: `cd functions && npm run build`
Expected: succeeds with no errors (this is a schema relaxation plus a new export — nothing currently depends on `sessions` having `min(1)`, and `sessionSchema` wasn't exported before so nothing can conflict).

- [ ] **Step 4: Commit**

```bash
git add functions/src/lib/schemas.ts
git commit -m "feat: allow sparse sessions in incremental program update schema"
```

---

### Task 2: `mergeIncrementalSessions` helper

**Files:**
- Create: `functions/src/lib/programMerge.ts`
- Test: `functions/test/programMerge.test.ts`

**Interfaces:**
- Consumes: `SessionOutput` type from `functions/src/lib/schemas.ts` (Task 1).
- Produces: `export function mergeIncrementalSessions(existingSessions: SessionOutput[], updatedSessions: SessionOutput[]): SessionOutput[]` — consumed by Task 3's `generateProgram.ts`.

- [ ] **Step 1: Write the failing tests**

Create `functions/test/programMerge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeIncrementalSessions } from "../src/lib/programMerge";
import type { SessionOutput } from "../src/lib/schemas";

function session(day: string, label: string): SessionOutput {
  return {
    day,
    label,
    focus_note: null,
    exercises: [
      { name: "Placeholder", sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null },
    ],
  };
}

describe("mergeIncrementalSessions", () => {
  it("carries every existing session forward when nothing was updated", () => {
    const existing = [session("Mon", "Lower"), session("Wed", "Upper")];
    const result = mergeIncrementalSessions(existing, []);
    expect(result).toEqual(existing);
  });

  it("replaces only the days present in the update, keeping the rest", () => {
    const existing = [session("Mon", "Lower v1"), session("Wed", "Upper v1"), session("Fri", "Full v1")];
    const updatedWed = session("Wed", "Upper v2");
    const result = mergeIncrementalSessions(existing, [updatedWed]);
    expect(result).toEqual([session("Mon", "Lower v1"), updatedWed, session("Fri", "Full v1")]);
  });

  it("appends a day from the update that wasn't in the existing week", () => {
    const existing = [session("Mon", "Lower v1")];
    const newDay = session("Sat", "New Long Run");
    const result = mergeIncrementalSessions(existing, [newDay]);
    expect(result).toEqual([session("Mon", "Lower v1"), newDay]);
  });

  it("returns an empty array when both inputs are empty", () => {
    expect(mergeIncrementalSessions([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd functions && npx vitest run test/programMerge.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/programMerge'` (file doesn't exist yet).

- [ ] **Step 3: Implement `mergeIncrementalSessions`**

Create `functions/src/lib/programMerge.ts`:

```ts
import { SessionOutput } from "./schemas";

// weeklyStructure covers all 7 days including rest days, but `sessions` only
// covers training days -- so this merges by the union of days present in
// existingSessions/updatedSessions rather than cross-referencing
// weeklyStructure (which would demand a session for every rest day too).
export function mergeIncrementalSessions(
  existingSessions: SessionOutput[],
  updatedSessions: SessionOutput[]
): SessionOutput[] {
  const updatedByDay = new Map(updatedSessions.map((s) => [s.day, s]));
  const existingByDay = new Map(existingSessions.map((s) => [s.day, s]));

  const merged = existingSessions.map((s) => updatedByDay.get(s.day) ?? s);

  for (const s of updatedSessions) {
    if (!existingByDay.has(s.day)) merged.push(s);
  }

  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd functions && npx vitest run test/programMerge.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/src/lib/programMerge.ts functions/test/programMerge.test.ts
git commit -m "feat: add mergeIncrementalSessions for sparse program-update diffs"
```

---

### Task 3: Wire the fix into `generateProgram.ts`

**Files:**
- Modify: `functions/src/generate/generateProgram.ts:1-9` (imports), `:159-161` (`INCREMENTAL_SYSTEM_PROMPT` step 3), `:491` (`maxTokens`), `:507-508` (merge candidate)

**Interfaces:**
- Consumes: `mergeIncrementalSessions` from `functions/src/lib/programMerge.ts` (Task 2).

This task changes a code path that only runs against the real Anthropic API (no mock-Claude test harness exists in this codebase, and adding one is out of scope per the spec). Verification here is a clean build; end-to-end behavior is confirmed in Task 4 via the real-API manual probe.

- [ ] **Step 1: Import `mergeIncrementalSessions`**

In `functions/src/generate/generateProgram.ts`, add to the top import block (after the `programDecisions` import):

```ts
import { mergeIncrementalSessions } from "../lib/programMerge";
```

- [ ] **Step 2: State the sparse-diff contract in the prompt**

Replace step 3 of `INCREMENTAL_SYSTEM_PROMPT`:

```ts
3. Write the updated "sessions" using the same exercise-writing rules as a fresh plan: every
   item (including runs/conditioning) as an exercise with sets/reps/rir/rest_seconds/notes.
   Seed loads from current lifts and the progression data.
```

with:

```ts
3. Write "sessions" AS A DIFF, not a full re-list: include an entry only for a day whose
   exercises/sets/reps/load are actually changing based on the fresh data. Omit any day whose
   session should stay exactly as it is in the existing week — it will be carried forward
   automatically, so do not restate it. "sessions" may be empty if nothing should change (e.g.
   no Hevy data to act on). A day that's new to the schedule (not present in the existing week
   above) must be included in full, since there is nothing existing to carry forward for it. For
   any session you do include, use the same exercise-writing rules as a fresh plan: every item
   (including runs/conditioning) as an exercise with sets/reps/rir/rest_seconds/notes, loads
   seeded from current lifts and the progression data.
```

- [ ] **Step 3: Raise `maxTokens` to match the schedule call's budget**

Change (inside the incremental branch's `extractStructuredJson` call):

```ts
      inputSchema: programUpdateJsonSchema,
      validator: programUpdateSchema,
      maxTokens: 3000,
    });
```

to:

```ts
      inputSchema: programUpdateJsonSchema,
      validator: programUpdateSchema,
      maxTokens: 7000,
    });
```

- [ ] **Step 4: Use the merge helper instead of the raw model output**

Change:

```ts
      currentState: update.currentState,
      weeklyStructure: update.weeklyStructure,
      sessions: update.sessions,
      coachNotes: update.coachNotes,
```

to:

```ts
      currentState: update.currentState,
      weeklyStructure: update.weeklyStructure,
      sessions: mergeIncrementalSessions(activeProgram!.sessions ?? [], update.sessions),
      coachNotes: update.coachNotes,
```

- [ ] **Step 5: Build to verify no type errors**

Run: `cd functions && npm run build`
Expected: succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add functions/src/generate/generateProgram.ts
git commit -m "fix: stop truncating incremental program updates, diff instead of full re-emit"
```

---

### Task 4: Update the manual latency probe and verify end-to-end

**Files:**
- Modify: `functions/test/generationLatency.manual.test.ts` (`FIXTURE_EXISTING_WEEK`, the `"program incremental update"` case's `maxTokens`)

**Interfaces:**
- Consumes: nothing new — this task only updates test fixtures/config, then runs the full suite plus the real-API probe as end-to-end verification of Tasks 1-3.

- [ ] **Step 1: Give the fixture real existing sessions to diff against**

The current `FIXTURE_EXISTING_WEEK` has `sessions: []`, which forces full re-emission regardless of Task 3's changes (there's nothing to carry forward). Replace:

```ts
const FIXTURE_EXISTING_WEEK = JSON.stringify({
  weeklyStructure: [
    { day: "Mon", focus: "Lower body strength" },
    { day: "Wed", focus: "Upper body strength" },
    { day: "Fri", focus: "Full body + conditioning" },
    { day: "Sat", focus: "Long run" },
  ],
  sessions: [],
});
```

with:

```ts
const FIXTURE_EXISTING_WEEK = JSON.stringify({
  weeklyStructure: [
    { day: "Mon", focus: "Lower body strength" },
    { day: "Wed", focus: "Upper body strength" },
    { day: "Fri", focus: "Full body + conditioning" },
    { day: "Sat", focus: "Long run" },
  ],
  sessions: [
    {
      day: "Mon",
      label: "Lower Body Strength",
      focus_note: "Heavy compound work, moderate volume",
      exercises: [
        { name: "Back Squat", sets: 4, reps: "5", rir: "2", rest_seconds: 180, load_note: "100kg last week", substitution_note: null },
        { name: "Romanian Deadlift", sets: 3, reps: "8", rir: "2", rest_seconds: 120, load_note: null, substitution_note: null },
      ],
    },
    {
      day: "Wed",
      label: "Upper Body Strength",
      focus_note: "Push/pull balance",
      exercises: [
        { name: "Bench Press", sets: 4, reps: "5", rir: "2", rest_seconds: 180, load_note: "70kg last week", substitution_note: null },
        { name: "Barbell Row", sets: 3, reps: "8", rir: "2", rest_seconds: 120, load_note: null, substitution_note: null },
      ],
    },
    {
      day: "Fri",
      label: "Full Body + Conditioning",
      focus_note: "Lighter loading before the weekend long run",
      exercises: [
        { name: "Trap Bar Deadlift", sets: 3, reps: "6", rir: "2", rest_seconds: 150, load_note: null, substitution_note: null },
        { name: "Sled Push", sets: 4, reps: "20 m", rir: "n/a", rest_seconds: 90, load_note: "conditioning finisher", substitution_note: null },
      ],
    },
    {
      day: "Sat",
      label: "Long Run",
      focus_note: "Easy aerobic pace",
      exercises: [
        { name: "Zone-2 long run", sets: 1, reps: "60 min", rir: "n/a", rest_seconds: 0, load_note: "conversational pace", substitution_note: null },
      ],
    },
  ],
});
```

- [ ] **Step 2: Raise the case's `maxTokens` to match production**

In the `cases` array, change the `"program incremental update"` entry's two `maxTokens: 3000` occurrences (the case-level field and the `extractStructuredJson` call's `maxTokens` parameter) to `maxTokens: 7000`.

- [ ] **Step 3: Run the full non-manual suite**

Run: `cd functions && npm run build && npx vitest run --exclude "**/test/rules.test.ts"`
Expected: all tests pass (including the new `programMerge.test.ts` from Task 2); the manual latency file continues to self-skip (no `ANTHROPIC_API_KEY` in that environment).

- [ ] **Step 4: Commit**

```bash
git add functions/test/generationLatency.manual.test.ts
git commit -m "test: exercise the sparse-diff path in the manual latency probe"
```

- [ ] **Step 5: Manual verification with a real Anthropic key (not automated — costs real money)**

This step can't be scripted as pass/fail in this plan; run it yourself per `functions/test/README.md`:

```bash
cd functions
ANTHROPIC_API_KEY=sk-ant-... npx vitest run test/generationLatency.manual.test.ts
```

Expected: all 4 cases pass — specifically, "program incremental update" no longer hits `stopReason: "max_tokens"` and completes well under the 300s function timeout. If it still truncates, `maxTokens: 7000` may need to go higher; if it passes but the `outputTokens` logged is barely smaller than before, check the model actually received the new prompt wording (i.e. that Task 3 Step 2 landed) before concluding the diff instruction isn't working.
