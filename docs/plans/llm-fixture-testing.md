# Fixture-based tests for LLM-backed generation (no real API calls)

## Context

Every real correctness check we've done on `generateProgram`/`groupProgram`
this session required either a real, billed Anthropic call (including one
made *accidentally* by the emulator, which turned out to have live access to
the `ANTHROPIC_API_KEY` secret) or manual Firestore seeding that bypasses the
generation logic entirely (`scripts/seed-group-demo.cjs`). Neither is
something CI can run, and neither actually exercises the orchestration code
(`needsGroupFullRegen`'s Stage A/B branching, the archive-and-write batch,
`reconcileEvents`, `applySessionLoads`, the check-in precondition ordering we
just fixed). Since every LLM call in the app already goes through one
function — `extractStructuredJson` (`functions/src/lib/claude.ts`) — and its
inputs/outputs are already schema-constrained (JSON Schema for the tool call,
zod for validation), that's the one seam to mock: replace it with
schema-valid canned fixtures, keep everything else (the real Firestore
emulator, the real orchestration functions) as-is, and get free, repeatable,
CI-runnable tests for the exact scenarios we've been eyeballing by hand.

Covers all four LLM-backed features: `generateProgram` (personal),
`groupProgram` (Stage A/B), `generateMealPlan`, `parseBodyScan`.

## Approach

**Mock at the `extractStructuredJson` boundary, not the Anthropic SDK.**
`vi.mock("../src/lib/claude", ...)` replacing `extractStructuredJson` with a
fixture-driven fake keyed by `params.toolName` — the same key every call site
already passes and the same key `costUsd` logging already groups by. This is
the natural seam: everything upstream (prompt construction) is exercised for
real since we still call `extractStructuredJson`'s call site, and everything
downstream (merging, Firestore writes, decision logic) runs unmocked for
real against the Firestore emulator — same emulator, same `--project demo-ci`
pattern CI already uses for `test/rules.test.ts`.

**Fixtures live in `functions/test/fixtures/llmFixtures.ts`**, one entry per
`toolName`, each a plain object *validated against its real zod schema in a
sanity test* so fixture drift from a schema change fails loudly instead of
silently producing an invalid mock. A `fakeExtractStructuredJson(overrides?)`
factory returns a `vi.fn()` that looks up the fixture by `toolName`,
deep-merges any per-test `overrides[toolName]`, and returns it — so a test
that needs "the model additionally proposes an event the group didn't state"
only specifies that one field, not a whole new fixture.

**New Firestore-emulator-backed suite, one file per feature**, calling the
real exported orchestration function directly (`runGenerateProgram`,
`runGenerateGroupProgram`, the meal-plan/body-scan equivalents) — not via
HTTP/onCall — after seeding whatever Firestore state that scenario needs via
the Admin SDK (same seeding pattern already used all session, e.g.
`scripts/seed-group-demo.cjs`). Assertions: what got written to Firestore,
what got returned, and — via the mock's `.mock.calls` — *which* toolNames
were actually invoked (e.g. asserting Stage A's `record_group_program` was
**not** called confirms the "structure unchanged, skip regen" path for real,
not just in the pure `needsGroupFullRegen` unit test).

## Scenarios (group generation — the ones we've been manually debugging)

In `functions/test/groupGeneration.integration.test.ts`:
1. Fresh group, no prior program → both Stage A and Stage B run; shared doc
   gets the right `groupSnapshot`; the triggering member's layer doc is written.
2. Group has stated events; the fixture's Stage A response proposes an
   *extra* event the group didn't state → written doc has only the group's
   event (confirms `reconcileEvents` end-to-end, not just its own unit test).
3. A member with no `training_days_per_week`/`session_length_minutes` on
   their own profile checks in → succeeds (confirms the precondition-ordering
   fix end-to-end via `runGenerateProgram` itself).
4. Existing fresh, structurally-unchanged program → only Stage B's toolName
   is called; the shared program doc is untouched.
5. Leader edits the group's goal/daysPerWeek, then a member regenerates →
   Stage A reruns and the new doc reflects the edited values (confirms the
   `groupSnapshot` staleness-detection fix end-to-end).
6. A new member (added after Stage A last ran, so absent from
   `profileSnapshots`) checks in → Stage A reruns for them; another existing
   member's own layer doc is untouched.

## Scenarios (the other three features)

**`functions/test/generateProgram.integration.test.ts`** (personal path,
`runGenerateProgram` with `activeProgramSource` absent/`"personal"`):
1. First-ever generation → full path, both `record_program_overview` and
   `record_program_schedule` called; new `users/{uid}/programs` doc written
   with `status: "active"`, `state/summary.currentProgramId` set.
2. Routine check-in, no structural change → only `record_program_update`
   called; written sessions are the existing ones merged with the fixture's
   diff via the real `mergeIncrementalSessions`, not a full re-list.
3. A structural profile change (e.g. `training_days_per_week` differs from
   the active program's `profileSnapshot`) → full path runs again, same as
   scenario 1.

**`functions/test/generateMealPlan.integration.test.ts`**
(`runGenerateMealPlan`, `toolName: "record_meal_plan"`, `mealPlanSchema`):
1. Happy path — seed `users/{uid}.nutrition` + `state/summary.currentTargets`
   → prior active `mealPlans` doc (if seeded) archived, new one written with
   `targetsSnapshot`, `state/summary.currentMealPlanId` updated.
2. Missing `currentTargets` → throws `failed-precondition` **before** any
   LLM call — assert the mock's `record_meal_plan` was never invoked.
3. Fixture's proposed plan contains a food matching a seeded allergy/avoid
   string → confirms the existing post-generation safety guard (`internal`
   error) fires for real, not just in isolation.

**`functions/test/parseBodyScan.integration.test.ts`**
(`toolName: "record_body_scan"`, `bodyScanExtractionSchema`, PDF input via
`pdfBase64` rather than `userText`): also mock the Storage boundary
(`bucket.file(...).download()`) alongside `extractStructuredJson`, so this
suite stays Firestore-emulator-only like the other three rather than also
needing the Storage emulator and a real seeded PDF fixture.
1. Happy path — mocked download returns dummy PDF bytes, fixture returns a
   valid extraction → `users/{uid}/bodyScans/{scanId}` written with
   `extracted`, `confirmedByUser: false`, `rawModelOutput`.
2. `storagePath` not under `users/{uid}/bodyscans/` → rejected before any
   Storage or LLM call.

## Fixture data source

Base each fixture on real shapes we already have on hand rather than
inventing from scratch: the `record_group_program`/`record_member_layer`
fixtures can lift directly from the actual production output captured
earlier this session (group `cySVvxQLjRe23FSODXi7`'s program doc — real
Hyrox Doubles data, already schema-valid); the personal-program fixtures
similarly from the real `record_program_overview`/`record_program_schedule`
output logged during earlier testing. Meal-plan and body-scan fixtures are
hand-written (no real captured output on hand for those), kept small (1-2
days / one plausible extraction).

## CI wiring

Extend `.github/workflows/ci.yml`'s existing pattern exactly — a third
`emulators:exec --only firestore --project demo-ci "npx vitest run <these
files>"` step (or broaden the existing rules-tests step's file glob to
include `**/*.integration.test.ts` alongside `rules.test.ts`), so the new
suite runs in CI the same offline, demo-project way the rules suite already
does. Update `functions/test/README.md`'s "everything runs in CI except..."
list to mention the new files need the emulator too (same as rules.test.ts),
distinguishing them from the genuinely-manual, real-key
`generationLatency.manual.test.ts`.

## Testing (of the tests)

Run locally the same way `test:rules` already documents: start/point at the
Firestore emulator, then `npx vitest run test/groupGeneration.integration.test.ts`
(and the sibling files). Confirm the existing non-emulator suite
(`npx vitest run --exclude ...`) still passes unchanged — this is additive,
no existing test or production code path changes.
