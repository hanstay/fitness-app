# Plan: Incremental program regeneration ("adjust current block")

## Context

`generateProgram` regenerates the **entire** program document on every call —
roadmap, all phases, weekly structure, every session, and all the prose notes —
via a single forced-tool LLM call (`generateProgram.ts:317`, `extractStructuredJson`
with `maxTokens: 8192`). On a routine weekly check-in ("Update my plan") almost
none of that changes: the goal, events, roadmap, and periodization are stable;
what actually moves week-to-week is the **current block's loads/volume/session
detail** (adjusted from fresh Hevy progression + adherence) and the **currentState
snapshot** (CTL/ATL/TSB + highlights).

Because latency and cost are **output-token bound** (the ~8192-token program
dominates; a run is ~3–5 min), re-emitting the whole document every week is the
main cost. Regenerating only the parts that change should cut output to roughly a
third and wall-clock close to proportionally, and — with a smaller schema —
reduce the validation-retry doubling in `extractStructuredJson` (`claude.ts:60`).

Goal: add an **incremental** path that adjusts the current block in place while
carrying the stable scaffolding forward from the active program, and reserve the
existing full regeneration for when the plan's *structure* must actually change.

Non-goals: changing the model, prompt caching (low value for this sparse,
output-heavy call), or touching the meal-plan generator.

## Key facts (verified)

- `generateProgram` (`generateProgram.ts`) loads `athlete`, `state/summary`
  (wellness, currentTargets), recent `activities`, and Hevy `strengthSessions`;
  builds `progressionBlock` + `adherenceBlock`; calls `extractStructuredJson`
  (`:317`) against `programJsonSchema` / `programSchema`; then archives the active
  program and writes a new doc with `...program, profileSnapshot: athlete`
  (`:337`) and sets `summary.currentProgramId` (`:339`).
- The program schema is large: `title, goalSummary, split, daysPerWeek,
  currentState, events, roadmap[], weeklyStructure[], sessions[], running,
  warmupNotes, progressionRules, deloadGuidance, coachNotes, sportNotes,
  nutritionNote` (`schemas.ts`). Prescribed exercises are semi-numeric (`reps`
  string, `load_note` free text).
- Program history is preserved by the **archive-and-write-new** pattern, and the
  app reads the current program via `summary.currentProgramId` (program.html,
  and now `parseHevyCsv`'s adherence).
- `profileSnapshot` is stored on every program (`:337`), so the structural inputs
  at generation time are available to diff against — no extra call needed.
- The check-in "Your program is updated ✓" card currently derives "what changed"
  from `currentState.highlights`; there is no explicit changelog field.

## Approach

### Part 1 — Decide full vs incremental (server-side, no LLM call)

In `generateProgram`, after loading `athlete` + the active program, compute
`needsFullRegen`:

- **Full** (today's path) if any of:
  - no active program (first generation);
  - a structural input changed vs `activeProgram.profileSnapshot` — `goal`,
    `events` (names/dates), `training_days_per_week`, `session_length_minutes`,
    `preferred_split`, `equipment`, `fixed_sessions`;
  - the block is **stale**: `activeProgram.createdAt` older than ~6 weeks
    (a mesocycle). Roadmap `dates` are free-text and unreliable to parse, so
    time-since-generation is the pragmatic stand-in for "you've reached the next
    phase" and also caps drift (see Risks).
- **Incremental** otherwise.

A `structuralChanged(athlete, snapshot)` helper (pure, unit-testable) does the
field-by-field diff. Keep an override so an explicit "start fresh" from the UI can
force full regen later if wanted.

### Part 2 — The incremental call

New smaller schema `programUpdateSchema` (sibling of `programSchema` in
`schemas.ts`):

- `currentState` (same shape as today),
- `weeklyStructure[]`,
- `sessions[]` (the detailed current block),
- `changeSummary: string[]` — the explicit "what changed" list,
- optional `coachNotes`, `nutritionNote`, `running`.

A focused system prompt ("You are adjusting the CURRENT block of an existing
periodized program from fresh data. Do NOT change the roadmap, goal, events, or
phase structure. Output the updated current week + a short changelog."). The
`userText` includes the **existing** current block (`sessions` + `weeklyStructure`
from the active program) plus the same grounding blocks already built
(progression, adherence, wellness, current lifts). Call `extractStructuredJson`
with `maxTokens: ~3000` and `validator: programUpdateSchema`.

### Part 3 — Merge and write

```
const merged = {
  ...activeProgram,          // roadmap, events, goalSummary, title, split,
                             // daysPerWeek, warmupNotes, progressionRules,
                             // deloadGuidance, sportNotes carried forward
  ...updateResult,           // currentState, weeklyStructure, sessions,
                             // changeSummary, (coachNotes/nutritionNote/running)
  profileSnapshot: athlete,  // refresh
  updatedAt: serverTimestamp,
};
```

Reuse the existing archive-old-active → write-new-doc → set `currentProgramId`
batch (`:327–340`) so history is preserved identically. Strip stored-only fields
(`createdAt`, `status`, `model`) from `activeProgram` before spreading, or set
them explicitly on the new doc.

### Part 4 — Surface the changelog

Persist `changeSummary` on the program. The check-in "Your program is updated ✓"
card renders it directly (falling back to `currentState.highlights` when absent,
e.g. on a full regen). This is the richer "what changed" the view already wants —
frontend change is additive and small.

## Testing

- Unit: `structuralChanged` (each field flips the result; identical snapshot →
  false), `needsFullRegen` (no-program, stale, structural-change, and
  routine-incremental cases). Pure, no emulator.
- `programUpdateSchema` validation round-trips a representative update payload.
- Emulator smoke: seed an active program, run an incremental update, assert the
  new doc keeps roadmap/events/goal verbatim, replaces sessions/currentState, and
  carries `changeSummary`; confirm `currentProgramId` advanced and the old doc is
  archived.

## Risks & mitigations

- **Drift** — many small incremental nudges wandering from roadmap intent.
  Mitigated by the ~6-week staleness rule forcing a full re-periodization, so
  drift can accumulate at most one block.
- **Two paths / two schemas** — divergence risk between the carried-forward fields
  and the update schema. Mitigate by deriving `programUpdateSchema` field shapes
  from the shared exercise/session sub-schemas in `schemas.ts` rather than
  duplicating them.
- **Snapshot completeness** — the diff is only as good as `profileSnapshot`;
  confirm it captures every structural field (it stores the whole `athlete`).
- **Latency win is real but bounded by output** — this is the right lever; a model
  swap is not (see the Sonnet-5 discussion). Measure before/after output tokens to
  confirm the expected ~⅓.

## Out of scope / open questions

- Whether to expose the full-vs-incremental choice in the UI, or keep it fully
  automatic (recommended: automatic).
- Whether phase boundaries should be tracked explicitly (a `currentPhaseIndex` +
  block counter) instead of the time-since heuristic — deferred; revisit if the
  6-week rule proves too coarse.
