# Groups: shared training plans for people who train together

**Superseded in part:** group *creation* (`createGroup`'s signature, the
one-step "enter emails and it generates immediately" flow, and
`public/groups.html`'s form) is replaced by the staged leader-led flow in
[groups-creation-staged-leader-flow.md](groups-creation-staged-leader-flow.md)
— create (with goal/events/schedule) → add teammates → explicitly generate.
Everything else below (data model, generation, rules, client program
rendering) is unchanged and still current.

## Status (as of this check-in)

Done: schemas, Firestore rules (+ emulator-verified rules tests),
`onUserCreate` fields, `needsGroupFullRegen`, `groundingData.ts` extraction,
`groupProgram.ts` (Stage A/B generation), `createGroup.ts`,
`groupMembership.ts`, wired into `index.ts`; `program.html`'s
`activeProgramSource` branch; the new `groups.html` page (create/toggle/leave)
linked from `dashboard.html`. Unit tests (field-split completeness,
`needsGroupFullRegen`) and `groups/{groupId}` Firestore rules tests pass.

Not yet done: no live end-to-end run against a real Anthropic key (the
generation prompts/schemas are untested against actual model output), and no
one has clicked through `groups.html` in a browser yet — see Testing below
for what's still manual.

## Changes from the previous draft (per your feedback)

1. **Load prescriptions are per-member, not shared.** Exercise selection,
   sets/reps/RIR/rest and the generic `substitution_note` are shared; the
   actual weight/`load_note` for lifts is computed per member from their own
   progression data, not copy-pasted across the group.
2. **Group membership doesn't take over your program.** Being in a group is
   independent from which plan is currently "active" for you — you can be in
   a group and still run your own individual plan, and switch between the two
   without losing either one.
3. **Group creation/management is a real page in the app**, not a one-off
   script — so you (or anyone) can create a group, invite by email, leave, and
   switch plan source, repeatably, without me touching Firestore by hand.

## Context

Multiple users want to train together and follow the same plan. Model this as
a **group**: a group has one shared program (structure); each member keeps
their own personal state, constraints, and — importantly — their own load
prescriptions and their own separate individual program, which continues to
exist untouched. No group/pairing concept exists anywhere in the codebase
today (confirmed by grep), and everything here is additive: a user who never
joins a group behaves exactly as today.

## Data model

New top-level collection:
- `groups/{groupId}` — `{ memberUids: string[], createdAt }`
- `groups/{groupId}/programs/{programId}` — the shared **structure**: same
  shape as `programSchema` minus per-exercise `load_note` (stripped/null in
  the shared doc — see below), same lifecycle as personal programs
  (`status: "active"|"archived"`, `createdAt`, `model`)
- `groups/{groupId}/members/{uid}` — this member's individual layer:
  `currentState`, `coachNotes`, `sportNotes`, `nutritionNote`,
  `profileSnapshot`, and `sessionLoads` (this member's `load_note` per
  exercise, keyed to the shared session skeleton — see below), upserted in
  place (not versioned; it just tracks each member's current personal layer)

`users/{uid}/state/summary` gains two fields:
- `groupId: string | null` — which group (if any) this user belongs to.
- `activeProgramSource: "personal" | "group"` — which plan is currently
  driving what they see/regenerate. Defaults to `"personal"`; a user only
  gets `"group"` by explicitly choosing it (default suggested to `"group"`
  right after joining, but it's a toggle, not a one-way migration).

`currentProgramId` keeps its exact existing meaning — the active doc in
`users/{uid}/programs`. It is **never repointed at a group doc.** The group's
own active program is found the same way personal ones already are today
(`groups/{groupId}/programs` where `status == "active"`, same one-query
pattern as `generateProgram.ts`'s `existingActiveSnap`) — so there's no
cross-member pointer to keep in sync, and no batch update needed when the
group program advances.

In `functions/src/lib/schemas.ts`:
- `PROGRAM_SHARED_FIELDS` — `title, goalSummary, split, daysPerWeek, events,
  roadmap, weeklyStructure, sessions (load_note stripped), running,
  progressionRules, deloadGuidance, warmupNotes`.
- `PROGRAM_INDIVIDUAL_FIELDS` — `currentState, coachNotes, sportNotes,
  nutritionNote`.
- `programSharedSchema` — `programSchema` picking `PROGRAM_SHARED_FIELDS`
  (mirrors the existing `programOverviewSchema`/`programScheduleSchema`
  split), used for the group's Stage A shared-structure call.
- `sessionLoadsSchema` — array parallel to `sessions`, one entry per day with
  `{ name, load_note }` per exercise (order/name-matched to the shared
  skeleton) — a member's personalized loads for a given shared structure.
- `memberLayerSchema` — `PROGRAM_INDIVIDUAL_FIELDS` + `sessionLoads`, the
  per-member generation output.

## Firestore rules

```
match /groups/{groupId} {
  allow read: if request.auth.uid in resource.data.memberUids;
  allow write: if false;
  match /programs/{id} {
    allow read: if request.auth.uid in get(/databases/$(database)/documents/groups/$(groupId)).data.memberUids;
    allow write: if false;
  }
  match /members/{uid} {
    allow read: if request.auth.uid in get(/databases/$(database)/documents/groups/$(groupId)).data.memberUids;
    allow write: if false;
  }
}
```

Group members can read each other's `members/{uid}` doc (personal
state/constraints) — intentional, since the point is training together and
seeing why the plan differs for a teammate. All writes stay Functions-only.

## Generation

In `functions/src/generate/generateProgram.ts`, `runGenerateProgram(uid)`
branches on `activeProgramSource` (not just `groupId`):

- **`"personal"` (default, unchanged):** exactly today's path — one athlete,
  one doc in `users/{uid}/programs`. A group member on `"personal"` never
  touches the group.
- **`"group"`:** two-stage generation, using a group analogue of the existing
  full-vs-incremental decision — `needsGroupFullRegen` in
  `functions/src/lib/programDecisions.ts`, which checks every current
  member's structural drift (not just one athlete's), roster changes (a new
  member with no snapshot yet forces Stage A), and staleness:
  1. **Stage A — shared structure** (only when the group program doesn't
     exist yet, or is structurally stale, same staleness/structural-change
     rule as today): load every group member's `athlete` profile (equipment,
     injuries, `training_days_per_week`) as a compact "training partners"
     context block, and generate one session structure that works for all of
     them, via a new prompt variant (sibling of the existing
     `OVERVIEW_SYSTEM_PROMPT`/`SCHEDULE_SYSTEM_PROMPT`). Output validated
     against `programSharedSchema`; write/archive into
     `groups/{groupId}/programs` exactly like the existing archive-and-write
     pattern (`generateProgram.ts:533-539`).
  2. **Stage B — this member's layer** (always runs, for the triggering
     member only): using their own grounding data (activities, Hevy
     progression — loaded exactly as today) plus the current shared session
     skeleton, generate `memberLayerSchema` — their `load_note` per exercise
     plus their `currentState`/`coachNotes`/`sportNotes`/`nutritionNote`.
     Upsert into `groups/{groupId}/members/{uid}`.
  If Stage A didn't need to run (structure still fresh), only Stage B runs —
  cheap, same as today's "incremental" cost profile. Other members' layers
  are left untouched and refresh on their own next check-in, same cadence as
  today (no cascading regeneration).

## Client (`public/program.html`)

Read `state/summary`; branch on `activeProgramSource`:
- `"personal"` (unchanged): `getDoc(users/{uid}/programs/{currentProgramId})`.
- `"group"`: query `groups/{groupId}/programs` where `status == "active"` for
  the shared structure, and `getDoc(groups/{groupId}/members/{uid})` for this
  user's layer; merge client-side — overlay `sessionLoads` onto the shared
  `sessions` skeleton by day+exercise name, spread the individual fields in —
  producing the same shape the render code already expects, so the actual
  rendering (roadmap, sessions, weeklyStructure) needs no changes.

## New page: `public/groups.html`

Follows the existing page pattern (`firebase-init.js`, `auth-guard.js`'s
`requireOnboarded()`, `httpsCallable(functions, ...)` — same imports/style as
`profile.html`). Features:
- Shows current group (if any): member list, and this user's
  `activeProgramSource`.
- **Create a group** — enter teammate email(s) → calls
  `createGroup({ memberEmails })`. Whether or not any member already has an
  individual plan is irrelevant: this just creates the `groups/{groupId}` doc,
  sets `groupId`/`activeProgramSource: "group"` on every member, and runs the
  group-aware generation path (Stage A shared structure + Stage B for the
  caller) — the group's first program is generated fresh from everyone's
  current profile/constraints, the same way any later regen works, not
  hand-carried from a prior doc. Existing individual plans stay untouched and
  dormant. Exposed as `onCall`, auth-gated so the caller's own uid must end up
  in the resolved member list (no separate accept/decline step for v1 —
  matches "the two of us just did this together in person").
- **Toggle plan source** — `setActiveProgramSource({ source: "personal" |
  "group" })`, only allows `"group"` if `groupId` is set.
- **Leave group** — `leaveGroup()`: removes this uid from `memberUids`, sets
  `groupId: null, activeProgramSource: "personal"` on the leaver; doesn't
  touch the group's history for remaining members.

New files: `functions/src/generate/createGroup.ts` (exports the `createGroup`
`onCall`, which resolves member emails to uids, writes the group doc, then
delegates to `runGenerateProgram` for the first program — no separate
core/wrapper split needed since nothing else calls this logic directly),
`functions/src/generate/groupMembership.ts` (`setActiveProgramSource`,
`leaveGroup`), both added to `functions/src/index.ts`'s flat re-export list.

## Testing

- Unit: `PROGRAM_SHARED_FIELDS ∪ PROGRAM_INDIVIDUAL_FIELDS` covers exactly
  `programSchema`'s keys (guards future schema fields from silently landing
  nowhere).
- Emulator smoke (`functions/test`):
  - Create group of 2 (regardless of whether either member had a prior
    individual plan) → both `groupId`/`activeProgramSource` set; Stage A+B run
    for the caller, producing one group program grounded in both members'
    current profiles; the other member's `members/{uid}` doc doesn't exist yet
    until their own next check-in; any prior individual `users/{uid}/programs`
    docs are untouched.
  - Member A regens (`"group"`, structure unchanged) → only Stage B runs,
    only A's `members/{A}` doc changes, group program doc untouched.
  - Member A regens with a structural change → Stage A + B run for A; member
    B's layer is untouched until B's own next check-in.
  - A user on `"personal"` inside a group never touches group collections.
- Manual: build `groups.html`, create the real group through the UI as
  yourself, confirm your partner sees the same structure with their own
  loads/notes in `program.html`, and that toggling back to `"personal"`
  restores your own prior individual program unchanged.
