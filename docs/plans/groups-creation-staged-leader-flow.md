# Group creation: staged leader-led flow

## Context

The currently-deployed `createGroup` flow (verified working end-to-end
against a real Anthropic call — see the recent production test:
`groups/y2QmjNPdPpAH2hWnAlrg`) is a single opaque step: enter teammate
emails, and it immediately creates the group *and* generates the first
shared program. Walking through the journey surfaced that this is too
unguided — there's no way to state what the group is training together for
before inviting people, and no natural moment to add teammates at your own
pace. This reframes group formation around a **group leader** (the creator)
who defines what's common to the group, then adds members, then explicitly
triggers generation — three deliberate steps instead of one.

This only changes **group formation**. Everything already deployed and
tested for the *ongoing* lifecycle — `runGenerateProgram`'s
`activeProgramSource` branch, `groupProgram.ts`'s Stage A/B split, weekly
check-in regen, `setActiveProgramSource`, self-service `leaveGroup` — is
unchanged and stays open to any member, per the decision that only setup
(who's in, what the group is for) should be leader-gated, not day-to-day use.

## Decisions

- Leader can add members; **cannot** remove them (self-leave only, kept simple).
- Ongoing regeneration stays open to **any** member — no change to already-shipped behavior.
- "Generate our plan" requires **≥1 member besides the leader** — enforced as a client-side gate (button disabled/hidden), not a backend restriction, so it doesn't touch the already-tested generation code path (a lone remaining member doing a routine check-in regen must still work).
- Adding a teammate with no account still just fails with a clear message — no invite/pending-signup system.
- Since leader-removal isn't in scope, if the leader tries to leave a group that still has other members, `leaveGroup` refuses ("You're the group leader — other members need to leave first") rather than silently orphaning the group. A leader can only leave once they're the last member.

## Data model

`groups/{groupId}` gains:
- `leaderUid: string` — set once at creation, immutable (no reassignment in this scope).
- `name: string | null` — optional group name.
- `goal: string` — required; what the group is training together for. Fed into Stage A's prompt as explicit context, distinct from each member's own individual `athlete.goal`.
- `events: Array<{ name: string; date: string | null }>` — the group's shared target event(s), same input shape as `athlete.events`. Optional (empty array is fine for open-ended goals). Collected in the create form via the existing `renderEventsEditor`/`collectEvents` from `public/js/events-editor.js`.
- `daysPerWeek: number` (1-7) — required; the schedule the group actually trains together on. Stated directly rather than inferred from combining each member's own `training_days_per_week` (today's error-prone approach) — **no group-level `preferred_split`**, since it's too rigid and risks fighting the LLM's own judgment on how to structure those days.
- `fixedSessions: Array<{ day: string; activity: string }>` — the group's shared recurring sessions (e.g. "Tuesday: Hyrox class together"), same shape as `athlete.fixed_sessions`. Optional. Collected via the existing `renderCommitmentsEditor`/`collectCommitments` from `public/js/commitments-editor.js`.
- **No group-level `equipment` field** — per-exercise `substitution_note` already covers individual equipment/constraint gaps; a group-level equipment list would be redundant.

No Firestore rules changes — the group doc is already fully readable by every member; these are just additional fields, and all writes stay Functions-only.

**Known limitation:** the group already created in production (`y2QmjNPdPpAH2hWnAlrg`) predates `leaderUid`/`goal` — it has neither. No migration is planned for this one-off test group; `addGroupMember`'s leader check will simply refuse both of its current members (a missing `leaderUid` matches nobody).

## Function changes

**`functions/src/generate/createGroup.ts`** — rewritten:
```ts
createGroup({ name, goal, events, daysPerWeek, fixedSessions })
```
Auth required; `goal` and `daysPerWeek` (1-7) required, `name`/`events`/`fixedSessions` optional — `events`/`fixedSessions` validated with small dedicated zod schemas (input shape, not the LLM-output `eventSchema` in `functions/src/lib/schemas.ts`, which additionally carries `weeksOut`/`goal` computed fields that don't exist on raw user input). Refuses if the caller is already in a group. Creates `groups/{groupId}` with `memberUids: [uid]`, `memberEmails: {uid: email}`, `leaderUid: uid`, `name`, `goal`, `events`, `daysPerWeek`, `fixedSessions`, `createdAt`. Sets the caller's `state/summary.groupId` + `activeProgramSource: "group"`. **Does not generate a program.** No `ANTHROPIC_API_KEY` secret needed anymore since this function no longer calls the LLM.

**New `functions/src/generate/addGroupMember.ts`**:
```ts
addGroupMember({ email })
```
Auth required; caller must be the group's `leaderUid` (fetch `groups/{groupId}` via the caller's own `state/summary.groupId`, compare). Resolves `email` → uid via `auth.getUserByEmail` — on failure, a clear `HttpsError("not-found", "No account found for {email} — ask them to sign up first, then add them.")`. Refuses if the target is already in a group. Updates `memberUids` (arrayUnion) and `memberEmails.{uid}` (dot-path field update) on the group doc, and sets the target's own `state/summary.groupId` + `activeProgramSource: "group"`.

**`functions/src/generate/groupMembership.ts`** — `leaveGroup` gains the leader guard described above: if `uid === group.leaderUid` and `memberUids.length > 1`, throw `failed-precondition`. Otherwise unchanged.

**`functions/src/generate/groupProgram.ts`** — `loadMemberUids` becomes `loadGroup`, additionally returning `name`/`goal`/`events`/`daysPerWeek`/`fixedSessions` from the group doc it already fetches. The Stage A prompt's user text gets a leading block:
```
Group's stated goal (from the group leader): {goal}
Group's target event(s): {events, or "none stated — infer from members' own profiles if they agree"}
Group's shared training days/week: {daysPerWeek} — schedule EXACTLY this many training days for the shared plan
Group's shared fixed weekly sessions (already committed, part of the days/week above): {fixedSessions, or "none"}
```
This **replaces** the per-member `training_days_per_week`/`fixed_sessions` lines currently built into each "Member N" block in `buildGroupProfileText` — those were always a poor proxy for "how many days do you actually train *together*," and individual side-commitments (e.g. a member's own unrelated class) shouldn't shape the shared session structure. Individual members' profiles still contribute goal/equipment/injuries/events context per member; only the schedule-shaping fields move to the group level.

`GROUP_SYSTEM_PROMPT` gets two adjustments: (1) the day-count/fixed-session hard-constraint instructions (already present, copied from the solo `SCHEDULE_SYSTEM_PROMPT`) now anchor on the group's stated `daysPerWeek`/`fixedSessions` instead of inferring a lowest-common-denominator; (2) when the group has stated events, treat them as authoritative for the `events`/`roadmap` output over any individual member's own (possibly stale or differently-worded) event entries.

**Generation trigger** — no new function: the guided flow's "Generate our plan" step calls the *existing* `generateProgram` callable (already deployed, already branches correctly on `activeProgramSource`), exactly like the check-in flow already does.

## Client (`public/groups.html`) — staged UI

Branches on `{ groupId, isLeader (== leaderUid === uid), memberCount }`:
- **No group:** "Create a group" form — Group name (optional), Group goal (required textarea), Days/week you train together (required number input), a target-events editor (`renderEventsEditor`/`collectEvents`), and a fixed-weekly-sessions editor (`renderCommitmentsEditor`/`collectCommitments`) — both from `public/js/`, the same components `profile.html` already uses for the individual equivalents → `createGroup({name, goal, events, daysPerWeek, fixedSessions})`, then re-render into the group view.
- **Has group, is leader:** group name/goal header, member list, an "Add a teammate" form (email → `addGroupMember`), and a "Generate our shared plan" button — disabled with a hint ("Add at least one teammate first") until `memberUids.length >= 2`. On success, redirect to `program.html` (immediate payoff, matching `onboarding.html`'s redirect-to-`dashboard.html` pattern).
- **Has group, not leader:** group name/goal header, member list, a note that only the leader adds members — no add-member form. Plan-source toggle + leave button as today.
- **Leave button:** on the `failed-precondition` leader-guard error, surface it plainly ("You're the leader — other members need to leave first").

## Testing

- No new automated tests planned for `createGroup`/`addGroupMember`/the leader guard — these are thin Admin SDK orchestration functions in the same style as the existing (also untested-at-the-unit-level) group functions; verification is via the emulator click-through, same method already used for the rest of this feature.
- Manual: re-run the emulator + seed-script flow (`functions/scripts/seed-group-demo.cjs` — needs a small update to set `leaderUid`/`goal`/`events`/`daysPerWeek`/`fixedSessions` on its seeded group doc so it still loads correctly), then click through: create as a fresh user (filling in the new fields), confirm generate is blocked solo, add a teammate, confirm generate unlocks, confirm redirect to `program.html`, confirm leave is blocked for the leader while the teammate is still in.
