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

export interface RoadmapPhaseForDecision {
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * Which roadmap phase (by index) a given ISO date falls into, using each
 * phase's startDate/endDate (inclusive). Returns null when the roadmap can't
 * be used for this — empty, or any phase missing a date — so callers fall
 * back to the staleness heuristic instead of guessing. A date past the last
 * phase's endDate resolves to roadmap.length (a "past the plan" sentinel);
 * one before the first phase's startDate resolves to -1.
 */
function phaseIndexForDate(roadmap: RoadmapPhaseForDecision[], dateStr: string): number | null {
  if (roadmap.length === 0) return null;
  if (!roadmap.every((p) => p.startDate && p.endDate)) return null;
  for (let i = 0; i < roadmap.length; i++) {
    const phase = roadmap[i];
    if (dateStr >= (phase.startDate as string) && dateStr <= (phase.endDate as string)) return i;
  }
  const last = roadmap[roadmap.length - 1];
  return dateStr > (last.endDate as string) ? roadmap.length : -1;
}

/**
 * True if the athlete has moved into a different roadmap phase than the one
 * active when the program was generated (e.g. the plan's "Base" phase ended
 * and today falls in "Hybrid Intensification"). False — never a reason to
 * force a regen — when the roadmap's dates aren't fully structured, since
 * the staleness heuristic already covers that case.
 */
export function hasEnteredNewPhase(
  roadmap: RoadmapPhaseForDecision[],
  createdAtDate: string,
  nowDate: string
): boolean {
  const phaseAtGeneration = phaseIndexForDate(roadmap, createdAtDate);
  const phaseNow = phaseIndexForDate(roadmap, nowDate);
  if (phaseAtGeneration == null || phaseNow == null) return false;
  return phaseNow !== phaseAtGeneration;
}

export interface ActiveProgramForDecision {
  profileSnapshot?: AthleteProfileSnapshot | null;
  /** Firestore Timestamp-like — anything with toMillis(). */
  createdAt?: { toMillis(): number } | null;
  roadmap?: RoadmapPhaseForDecision[] | null;
}

/**
 * Full regen if there's no active program yet, a structural input changed
 * since the active program was generated, the athlete has crossed into a
 * new roadmap phase since generation, or the active program is stale (older
 * than roughly one mesocycle). Incremental otherwise.
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
  const createdAtDate = new Date(createdAtMs).toISOString().slice(0, 10);
  const nowDate = now.toISOString().slice(0, 10);
  if (hasEnteredNewPhase(activeProgram.roadmap ?? [], createdAtDate, nowDate)) return true;
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
  roadmap?: RoadmapPhaseForDecision[] | null;
}

/**
 * Group analogue of needsFullRegen: the shared structure (Stage A) needs
 * regenerating if there's no group program yet, the member roster changed
 * (someone joined since the snapshot was taken), any current member's
 * profile changed structurally since their snapshot, the leader edited the
 * group's own goal/schedule/events since the snapshot, the group has crossed
 * into a new roadmap phase since generation, or the program is stale — same
 * triggers as the personal path, evaluated across every member.
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
  const createdAtDate = new Date(createdAtMs).toISOString().slice(0, 10);
  const nowDate = now.toISOString().slice(0, 10);
  if (hasEnteredNewPhase(activeProgram.roadmap ?? [], createdAtDate, nowDate)) return true;
  if (now.getTime() - createdAtMs > SIX_WEEKS_MS) return true;
  return false;
}

export interface RoadmapPhaseForContinuation extends RoadmapPhaseForDecision {
  phase: string;
  dates?: string | null;
  focus?: string | null;
}

/**
 * Where a full regeneration should pick the periodization back up, given
 * the roadmap it's replacing. Without this, a full regen only saw the
 * athlete's profile and rebuilt the macrocycle from its first phase
 * starting today — so "Start a new block" (or crossing a phase boundary)
 * dropped the athlete back into "Base" instead of moving them forward.
 *
 * targetIndex is the roadmap phase to program now: the phase today falls
 * in, or — when forced ("start a new block now") — at least the phase
 * after the one active at generation, so a forced regen always advances.
 * A value equal to roadmap.length means every phase is complete. Returns
 * null when there is no previous roadmap to continue from.
 */
export function resolveContinuation(params: {
  roadmap: RoadmapPhaseForContinuation[] | null | undefined;
  createdAtDate: string | null;
  nowDate: string;
  force: boolean;
}): { targetIndex: number; datesStructured: boolean } | null {
  const roadmap = params.roadmap ?? [];
  if (roadmap.length === 0) return null;
  const datesStructured = roadmap.every((p) => p.startDate && p.endDate);
  // Undated (legacy) roadmaps: assume the program was generated at its first
  // phase — the same fallback program.html/advice.html use for "This block".
  const clamp = (i: number | null, fallback: number) => (i == null ? fallback : Math.max(0, i));
  const atGeneration = clamp(params.createdAtDate ? phaseIndexForDate(roadmap, params.createdAtDate) : null, 0);
  const now = clamp(phaseIndexForDate(roadmap, params.nowDate), atGeneration);
  const target = params.force ? Math.max(now, atGeneration + 1) : now;
  return { targetIndex: Math.min(target, roadmap.length), datesStructured };
}

/**
 * Prompt text telling a full regeneration to continue the previous roadmap
 * (see resolveContinuation) rather than restart it. Empty string when there
 * is nothing to continue from.
 */
export function buildContinuationText(params: {
  roadmap: RoadmapPhaseForContinuation[] | null | undefined;
  createdAtDate: string | null;
  nowDate: string;
  force: boolean;
}): string {
  const resolved = resolveContinuation(params);
  if (!resolved) return "";
  const roadmap = params.roadmap as RoadmapPhaseForContinuation[];
  const { targetIndex, datesStructured } = resolved;

  const phaseLines = roadmap.map((p, i) => {
    const range = p.startDate && p.endDate ? ` [${p.startDate} → ${p.endDate}]` : "";
    const status = i < targetIndex ? " (COMPLETED)" : i === targetIndex ? " (← PROGRAM THIS BLOCK NOW)" : "";
    return `- ${p.phase}${p.dates ? ` (${p.dates})` : ""}${range}${p.focus ? ` — focus: ${p.focus}` : ""}${status}`;
  });

  let targetLine: string;
  if (targetIndex >= roadmap.length) {
    targetLine = "Every phase of the previous roadmap is complete — plan the next logical block that follows it " +
      "(e.g. the next build toward a remaining/new event, or a post-event transition), NOT a restart at Base.";
  } else {
    const why = params.force
      ? "the athlete explicitly asked to start the next block now"
      : "today falls in this phase";
    targetLine = `Block to program now: "${roadmap[targetIndex].phase}" (${why}).`;
  }

  return [
    `Previous plan (CONTINUE it — do not restart the periodization from the first phase):`,
    `Previous program generated on: ${params.createdAtDate ?? "unknown"}`,
    `Previous roadmap:`,
    ...phaseLines,
    targetLine,
    ...(datesStructured || params.force
      ? []
      : ["(The previous roadmap's phases weren't precisely dated — use their date labels and the time elapsed since it was generated to confirm which phase the athlete is actually in now.)"]),
  ].join("\n");
}
