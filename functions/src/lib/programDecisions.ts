// Decides whether generateProgram should do a full regeneration or an
// incremental "adjust the current block" update. Pure, no Firebase
// dependency — see docs/plans/incremental-program-regeneration.md for the
// design this implements.

export interface AthleteProfileSnapshot {
  goal?: string | null;
  events?: Array<{ name: string; date?: string | null }> | null;
  training_days_per_week?: number | null;
  session_length_minutes?: number | null;
  preferred_split?: string | null;
  equipment?: string[] | null;
  fixed_sessions?: Array<{ day: string; activity: string }> | null;
}

function sameStringSet(a?: string[] | null, b?: string[] | null): boolean {
  const sa = [...(a ?? [])].sort();
  const sb = [...(b ?? [])].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

function sameEvents(
  a?: Array<{ name: string; date?: string | null }> | null,
  b?: Array<{ name: string; date?: string | null }> | null
): boolean {
  const ea = (a ?? []).map((e) => `${e.name}|${e.date ?? ""}`).sort();
  const eb = (b ?? []).map((e) => `${e.name}|${e.date ?? ""}`).sort();
  return ea.length === eb.length && ea.every((v, i) => v === eb[i]);
}

function sameFixedSessions(
  a?: Array<{ day: string; activity: string }> | null,
  b?: Array<{ day: string; activity: string }> | null
): boolean {
  const fa = (a ?? []).map((s) => `${s.day}|${s.activity}`).sort();
  const fb = (b ?? []).map((s) => `${s.day}|${s.activity}`).sort();
  return fa.length === fb.length && fa.every((v, i) => v === fb[i]);
}

/** True if any structural input (goal, events, schedule shape, equipment) changed since the snapshot was taken. */
export function structuralChanged(
  athlete: AthleteProfileSnapshot,
  snapshot: AthleteProfileSnapshot | null | undefined
): boolean {
  if (!snapshot) return true;
  if ((athlete.goal ?? null) !== (snapshot.goal ?? null)) return true;
  if ((athlete.training_days_per_week ?? null) !== (snapshot.training_days_per_week ?? null)) return true;
  if ((athlete.session_length_minutes ?? null) !== (snapshot.session_length_minutes ?? null)) return true;
  if ((athlete.preferred_split ?? null) !== (snapshot.preferred_split ?? null)) return true;
  if (!sameStringSet(athlete.equipment, snapshot.equipment)) return true;
  if (!sameEvents(athlete.events, snapshot.events)) return true;
  if (!sameFixedSessions(athlete.fixed_sessions, snapshot.fixed_sessions)) return true;
  return false;
}

const SIX_WEEKS_MS = 6 * 7 * 24 * 60 * 60 * 1000;

export interface ActiveProgramForDecision {
  profileSnapshot?: AthleteProfileSnapshot | null;
  /** Firestore Timestamp-like — anything with toMillis(). */
  createdAt?: { toMillis(): number } | null;
}

/**
 * Full regen if there's no active program yet, a structural input changed
 * since the active program was generated, or the active program is stale
 * (older than roughly one mesocycle). Incremental otherwise.
 */
export function needsFullRegen(params: {
  athlete: AthleteProfileSnapshot;
  activeProgram: ActiveProgramForDecision | null;
  now?: Date;
}): boolean {
  const { athlete, activeProgram, now = new Date() } = params;
  if (!activeProgram) return true;
  if (structuralChanged(athlete, activeProgram.profileSnapshot)) return true;
  const createdAtMs = activeProgram.createdAt?.toMillis?.();
  if (createdAtMs == null) return true; // no reliable timestamp — be conservative
  if (now.getTime() - createdAtMs > SIX_WEEKS_MS) return true;
  return false;
}

export interface GroupDetailsSnapshot {
  goal?: string | null;
  daysPerWeek?: number | null;
  events?: Array<{ name: string; date?: string | null }> | null;
  fixedSessions?: Array<{ day: string; activity: string }> | null;
}

/** True if the group leader changed goal/daysPerWeek/events/fixedSessions since the snapshot was taken. */
export function groupDetailsChanged(
  group: GroupDetailsSnapshot,
  snapshot: GroupDetailsSnapshot | null | undefined
): boolean {
  if (!snapshot) return true;
  if ((group.goal ?? null) !== (snapshot.goal ?? null)) return true;
  if ((group.daysPerWeek ?? null) !== (snapshot.daysPerWeek ?? null)) return true;
  if (!sameEvents(group.events, snapshot.events)) return true;
  if (!sameFixedSessions(group.fixedSessions, snapshot.fixedSessions)) return true;
  return false;
}

export interface ActiveGroupProgramForDecision {
  /** Every member's athlete snapshot as of when this group program's shared structure was generated. */
  profileSnapshots?: Record<string, AthleteProfileSnapshot | null | undefined> | null;
  /** The group's own goal/daysPerWeek/events/fixedSessions as of that generation. */
  groupSnapshot?: GroupDetailsSnapshot | null;
  createdAt?: { toMillis(): number } | null;
}

/**
 * Group analogue of needsFullRegen: the shared structure (Stage A) needs
 * regenerating if there's no group program yet, the member roster changed
 * (someone joined since the snapshot was taken), any current member's
 * profile changed structurally since their snapshot, the leader edited the
 * group's own goal/schedule/events since the snapshot, or the program is
 * stale — same triggers as the personal path, evaluated across every member.
 */
export function needsGroupFullRegen(params: {
  memberAthletes: Record<string, AthleteProfileSnapshot>;
  group: GroupDetailsSnapshot;
  activeProgram: ActiveGroupProgramForDecision | null;
  now?: Date;
}): boolean {
  const { memberAthletes, group, activeProgram, now = new Date() } = params;
  if (!activeProgram) return true;
  if (groupDetailsChanged(group, activeProgram.groupSnapshot)) return true;
  const snapshots = activeProgram.profileSnapshots ?? {};
  for (const [uid, athlete] of Object.entries(memberAthletes)) {
    if (!(uid in snapshots)) return true; // new member, never snapshotted
    if (structuralChanged(athlete, snapshots[uid])) return true;
  }
  const createdAtMs = activeProgram.createdAt?.toMillis?.();
  if (createdAtMs == null) return true;
  if (now.getTime() - createdAtMs > SIX_WEEKS_MS) return true;
  return false;
}
