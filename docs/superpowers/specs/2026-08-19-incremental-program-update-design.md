# Incremental Program Update: Fix Truncation + Sparse Diff

## Context

`generateProgram.ts`'s incremental-update path (`record_program_update`, used for
routine weekly program adjustments as opposed to a full regen) calls
`extractStructuredJson` with `maxTokens: 3000`. The manual latency probe
(`test/generationLatency.manual.test.ts`) caught this call reliably hitting
`stopReason: "max_tokens"` on both the initial attempt and the retry, then
failing Zod validation because the truncated JSON was missing required fields
(`coachNotes`, `nutritionNote`, `running`).

Root cause: `programUpdateSchema` requires the model to re-emit the *entire*
current week (`weeklyStructure` + full `sessions` with exercises/sets/reps per
day) — the same shape and size as the full-regen schedule call, which is
budgeted at `maxTokens: 7000`. The incremental call was budgeted at less than
half that, with no design reason for the gap — it's a bug, not an intentional
tradeoff.

Digging into *why* the output is so large: the incremental prompt already asks
for a fresh full week even when adjusting only one or two days. There's no
mechanism for the model to say "days X and Y changed, everything else stays
the same" — so it always regenerates every session from scratch, every day.

This spec covers two changes: an immediate fix (raise the token budget to
match the schedule call) and a structural one (let the model emit a sparse
diff, cutting typical output size/cost/latency for the common case where most
days don't change).

## Goals

- Stop the incremental-update call from truncating (`maxTokens` fix).
- Reduce typical token usage for the common case (adjusting 1-2 days of a
  4-7 day week) via a sparse diff instead of full re-emission.
- Never silently drop a day's session — fail loudly if the merge can't
  resolve a session for every day in the new `weeklyStructure`.
- No change to full-regen behavior (`programOverviewSchema` /
  `programScheduleSchema` / their merge) — out of scope.

## Design

### 1. `maxTokens` fix

`generateProgram.ts`, the `record_program_update` call: `maxTokens: 3000` →
`7000`, matching `record_program_schedule`. Also bump the equivalent case in
`test/generationLatency.manual.test.ts` so the probe measures the real
production budget.

### 2. Schema: sparse `sessions`

`programUpdateSchema.sessions` (`lib/schemas.ts`) changes from
`z.array(sessionSchema).min(1).max(10)` to `z.array(sessionSchema).max(10)`
(dropping the `min(1)`). An empty array is a legitimate response — the
existing prompt already allows "no changes" (e.g. no Hevy data to act on).

The JSON tool schema's `sessions` property gets a `description` telling the
model the contract: include an entry only for a day whose session is actually
changing; omit any day that should stay exactly as-is (it's carried forward
automatically); a day that's new to the schedule (not present in the existing
week) must be included in full, since there's nothing to carry forward.

`weeklyStructure` is unchanged — always fully re-emitted (cheap: just
`day`/`focus`/`note` per day, no exercise detail), since it's the model's one
chance to say "this week's overall shape is now X days with these focuses."

### 3. Prompt: state the diff contract

`INCREMENTAL_SYSTEM_PROMPT` gets a new paragraph making the sparse-output
contract explicit — this is the actual fix for the root cause, since the
model currently has no signal that partial output is acceptable or expected:

> For `sessions`: only include an entry for a day whose exercises/sets/reps/
> load you are actually changing based on the fresh data. Omit any day whose
> session should stay exactly as it is in the existing week — it will be
> carried forward automatically, so do not restate it. `sessions` may be
> empty if nothing should change. Any day that's new to the schedule (i.e.
> not present in the existing week above) must have its session included in
> full, since there is nothing existing to carry forward for it.

### 4. Merge logic: `lib/programMerge.ts`

New pure module, following the existing pattern of extracted pure-logic
modules with dedicated tests (`lib/programDecisions.ts`, `lib/staleGeneration.ts`,
`lib/macros.ts`):

```ts
export function mergeIncrementalSessions(
  weeklyStructure: { day: string }[],
  existingSessions: { day: string }[],
  updatedSessions: { day: string }[]
): SessionType[] {
  const existingByDay = new Map(existingSessions.map((s) => [s.day, s]));
  const updatedByDay = new Map(updatedSessions.map((s) => [s.day, s]));

  return weeklyStructure.map(({ day }) => {
    const session = updatedByDay.get(day) ?? existingByDay.get(day);
    if (!session) {
      throw new Error(
        `Incremental program update: no session for day "${day}" — not in ` +
        `the model's response and no existing session to carry forward.`
      );
    }
    return session;
  });
}
```

`generateProgram.ts`'s incremental branch calls
`mergeIncrementalSessions(update.weeklyStructure, activeProgram!.sessions ?? [], update.sessions)`
and uses the result in place of `update.sessions` in the merge candidate.

This is the correctness safety net: if the model's `weeklyStructure` names a
day that's neither in its own sparse `sessions` output nor in the athlete's
existing program, the whole generation throws immediately rather than
producing a program silently missing a training day — consistent with this
codebase's existing fail-fast approach (e.g. the recent stale-generation
hang fix).

### 5. Manual-test fixture

`generationLatency.manual.test.ts`'s `FIXTURE_EXISTING_WEEK.sessions` is
currently `[]`. With no existing sessions to diff against, the model is
forced into full re-emission regardless of the redesign — it's a worst-case
fixture, not representative of a routine weekly update. Flesh it out with
representative sessions for Mon/Wed/Fri/Sat (matching its existing
`weeklyStructure`) so the probe actually exercises the sparse-diff path.

### 6. Tests

New `test/programMerge.test.ts` covering `mergeIncrementalSessions`:
- all days unchanged → full carry-forward from existing
- mixed: some days in `updatedSessions`, rest carried forward
- a day present in `weeklyStructure` and `updatedSessions` but absent from
  `existingSessions` (new day) → uses the update
- a day present in `weeklyStructure` but absent from both `existingSessions`
  and `updatedSessions` → throws

Then: `npm run build && npx vitest run --exclude "**/test/rules.test.ts"`,
and re-run the real-API manual latency probe to confirm no more truncation
and latency stays comfortably under the 300s function timeout.

## Out of scope

- Full-regen path (`programOverviewSchema`/`programScheduleSchema`) — already
  passes comfortably at its existing budget, untouched.
- Making `weeklyStructure` itself sparse — it's cheap enough that full
  re-emission isn't worth the added complexity.
- Handling multiple sessions per day (schema allows up to 10 sessions across
  up to 7 days) — existing behavior already keys loosely by `day`; not
  changed or newly broken by this design.
