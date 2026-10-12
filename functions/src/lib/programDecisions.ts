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
const DAY_MS = 86400000;

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface RoadmapPhaseForDecision {
  phase?: string;
  dates?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

function isDated(roadmap: RoadmapPhaseForDecision[]): boolean {
  return roadmap.length > 0 && roadmap.every((p) => p.startDate && p.endDate);
}

/**
 * Which roadmap phase (by index) a given ISO date falls into, using each
 * phase's startDate/endDate (inclusive). Returns null when the roadmap can't
 * be used for this — empty, or any phase missing a date. A date past the last
 * phase's endDate resolves to roadmap.length (a "past the plan" sentinel);
 * one before the first phase's startDate resolves to -1.
 */
export function phaseIndexForDate(roadmap: RoadmapPhaseForDecision[], dateStr: string): number | null {
  if (!isDated(roadmap)) return null;
  for (let i = 0; i < roadmap.length; i++) {
    const phase = roadmap[i];
    if (dateStr >= (phase.startDate as string) && dateStr <= (phase.endDate as string)) return i;
  }
  const last = roadmap[roadmap.length - 1];
  return dateStr > (last.endDate as string) ? roadmap.length : -1;
}

/**
 * Where a program is in its periodization. Stored on every program doc from
 * this change on and carried unchanged through weekly updates — unlike the
 * doc's createdAt, which every weekly update resets (the reason the 6-week
 * "stale block" rule could never fire for an athlete checking in weekly).
 */
export interface BlockState {
  roadmap?: RoadmapPhaseForDecision[] | null;
  /** Roadmap phase this program is programming. Absent on older programs. */
  currentPhaseIndex?: number | null;
  /** When the current phase/block started. Absent on older programs — see inferBlockStart. */
  blockStartedAtMs?: number | null;
}

/** The roadmap phase a program is currently in: stored index, else by its block start date, else the first. */
export function blockPhaseIndex(state: BlockState, today: string): number {
  const roadmap = state.roadmap ?? [];
  if (roadmap.length === 0) return 0;
  const clamp = (i: number) => Math.min(Math.max(i, 0), roadmap.length - 1);
  if (state.currentPhaseIndex != null) return clamp(state.currentPhaseIndex);
  const at = phaseIndexForDate(roadmap, state.blockStartedAtMs != null ? isoDate(state.blockStartedAtMs) : today);
  return at == null ? 0 : clamp(at);
}

/**
 * For programs saved before blockStartedAt existed: the createdAt of the
 * oldest consecutive program (newest first) sharing the active program's
 * roadmap — i.e. when that roadmap was generated, ignoring the weekly
 * updates since that each got their own createdAt.
 */
export function inferBlockStart(
  programsNewestFirst: Array<{ createdAtMs: number | null; roadmap?: RoadmapPhaseForDecision[] | null; blockStartedAtMs?: number | null }>
): number | null {
  if (programsNewestFirst.length === 0) return null;
  const first = programsNewestFirst[0];
  if (first.blockStartedAtMs != null) return first.blockStartedAtMs;
  const key = (r?: RoadmapPhaseForDecision[] | null) =>
    JSON.stringify((r ?? []).map((p) => [p.phase ?? null, p.startDate ?? null, p.endDate ?? null]));
  const firstKey = key(first.roadmap);
  let start = first.createdAtMs;
  for (const p of programsNewestFirst.slice(1)) {
    if (key(p.roadmap) !== firstKey) break;
    if (p.blockStartedAtMs != null) return p.blockStartedAtMs;
    if (p.createdAtMs != null) start = p.createdAtMs;
  }
  return start;
}

/**
 * - "incremental": routine weekly update — adjust this week, keep the plan.
 * - "advance": move to the next phase of the EXISTING roadmap — the roadmap
 *   (the athlete's periodization) is kept as-is; only the week and the
 *   phase's coaching guidance are rewritten for the new phase.
 * - "full": design a new plan — no plan yet, the goal/events/schedule
 *   changed, or every phase of the roadmap is done.
 */
export type RegenMode = "full" | "advance" | "incremental";

export interface RegenDecision {
  mode: RegenMode;
  reason: string;
  /** Phase the active program is in (null with no active program). */
  fromPhaseIndex: number | null;
  /** Phase to program now. roadmap.length for "full" because the roadmap is finished. */
  targetPhaseIndex: number | null;
}

export function decideRegen(params: {
  hasActiveProgram: boolean;
  structuralChange: boolean;
  state: BlockState;
  /** The athlete ticked "Move to the next phase now". */
  force: boolean;
  now?: Date;
}): RegenDecision {
  const { hasActiveProgram, structuralChange, state, force, now = new Date() } = params;
  if (!hasActiveProgram) return { mode: "full", reason: "no plan yet", fromPhaseIndex: null, targetPhaseIndex: null };

  const today = isoDate(now.getTime());
  const roadmap = state.roadmap ?? [];
  const from = blockPhaseIndex(state, today);
  if (structuralChange) {
    return { mode: "full", reason: "goal, events or schedule changed", fromPhaseIndex: from, targetPhaseIndex: from };
  }

  const stale = state.blockStartedAtMs == null || now.getTime() - state.blockStartedAtMs > SIX_WEEKS_MS;

  // Open-ended plan with no phases: a "new block" can only mean a new plan.
  if (roadmap.length === 0) {
    if (force) return { mode: "full", reason: "new block requested", fromPhaseIndex: 0, targetPhaseIndex: 0 };
    if (stale) return { mode: "full", reason: "block is over 6 weeks old", fromPhaseIndex: 0, targetPhaseIndex: 0 };
    return { mode: "incremental", reason: "weekly update", fromPhaseIndex: 0, targetPhaseIndex: 0 };
  }

  let target: number;
  let reason: string;
  if (isDated(roadmap)) {
    // The roadmap's own dates decide; a dated phase isn't cut short by the
    // 6-week rule. Never step backwards.
    const byDate = phaseIndexForDate(roadmap, today) as number;
    const natural = Math.max(from, byDate);
    target = force ? Math.max(natural, from + 1) : natural;
    reason = force && natural === from ? "next phase requested" : "the current phase's dates have ended";
  } else {
    target = force || stale ? from + 1 : from;
    reason = force ? "next phase requested" : "phase is over 6 weeks old";
  }

  if (target >= roadmap.length) {
    return { mode: "full", reason: "every phase of the plan is complete", fromPhaseIndex: from, targetPhaseIndex: roadmap.length };
  }
  if (target !== from) return { mode: "advance", reason, fromPhaseIndex: from, targetPhaseIndex: target };
  return { mode: "incremental", reason: "weekly update", fromPhaseIndex: from, targetPhaseIndex: from };
}

function dateLabel(start: string, end: string): string {
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * The roadmap to keep when advancing: unchanged, except that when the
 * athlete moves on EARLY (before the next phase's start date) the next phase
 * now starts today and the phase being left ends yesterday — so the dates
 * keep agreeing with where the athlete actually is. Later phases, and so the
 * run-in to any event, keep their dates.
 */
export function roadmapForAdvance<T extends RoadmapPhaseForDecision>(
  roadmap: T[],
  targetIndex: number,
  today: string
): T[] {
  const next = roadmap.map((p) => ({ ...p }));
  if (!isDated(next)) return next;
  const target = next[targetIndex];
  if (!target || today >= (target.startDate as string)) return next;
  target.startDate = today;
  target.dates = dateLabel(today, target.endDate as string);
  const prev = next[targetIndex - 1];
  if (prev) {
    const yesterday = isoDate(new Date(`${today}T00:00:00Z`).getTime() - DAY_MS);
    prev.endDate = yesterday < (prev.startDate as string) ? (prev.startDate as string) : yesterday;
    prev.dates = dateLabel(prev.startDate as string, prev.endDate);
  }
  return next;
}

export interface ActiveProgramForDecision {
  profileSnapshot?: AthleteProfileSnapshot | null;
}

/** Personal path: anything structural changed since the active program was generated? */
export function personalStructuralChange(athlete: AthleteProfileSnapshot, activeProgram: ActiveProgramForDecision): boolean {
  return structuralChanged(athlete, activeProgram.profileSnapshot);
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
}

/**
 * Group analogue of personalStructuralChange: the member roster changed
 * (someone joined since the snapshot), any current member's profile changed
 * structurally, or the leader edited the group's goal/schedule/events.
 */
export function groupStructuralChange(params: {
  memberAthletes: Record<string, AthleteProfileSnapshot>;
  group: GroupDetailsSnapshot;
  activeProgram: ActiveGroupProgramForDecision;
}): boolean {
  const { memberAthletes, group, activeProgram } = params;
  if (groupDetailsChanged(group, activeProgram.groupSnapshot)) return true;
  const snapshots = activeProgram.profileSnapshots ?? {};
  for (const [uid, athlete] of Object.entries(memberAthletes)) {
    if (!(uid in snapshots)) return true; // new member, never snapshotted
    if (structuralChanged(athlete, snapshots[uid])) return true;
  }
  return false;
}

export interface RoadmapPhaseForContinuation extends RoadmapPhaseForDecision {
  phase: string;
  focus?: string | null;
  lifting?: string | null;
  running?: string | null;
  nutrition?: string | null;
}

/**
 * The prompt section telling a regeneration where the athlete is in their
 * existing plan. For "advance" the roadmap is fixed and the model writes only
 * the new phase; for "full" (a redesign) it continues from where the athlete
 * is instead of restarting at the first phase. Empty when there's no previous
 * roadmap.
 */
export function buildContinuationText(params: {
  mode: "advance" | "full";
  roadmap: RoadmapPhaseForContinuation[] | null | undefined;
  targetIndex: number;
  reason: string;
}): string {
  const roadmap = params.roadmap ?? [];
  if (roadmap.length === 0) return "";
  const { targetIndex } = params;

  const phaseLines = roadmap.map((p, i) => {
    const range = p.startDate && p.endDate ? ` [${p.startDate} → ${p.endDate}]` : "";
    const status = i < targetIndex ? " (COMPLETED)" : i === targetIndex ? " (← PROGRAM THIS BLOCK NOW)" : "";
    return `- ${p.phase}${p.dates ? ` (${p.dates})` : ""}${range}${p.focus ? ` — focus: ${p.focus}` : ""}${status}`;
  });

  if (params.mode === "advance") {
    const t = roadmap[targetIndex];
    return [
      `Current plan — MOVING TO ITS NEXT PHASE (${params.reason}).`,
      `The roadmap below is FIXED: it is kept exactly as-is, so copy it into "roadmap" unchanged —`,
      `do not re-size, re-date, rename, add or drop phases. The athlete's periodization does not change;`,
      `your job is the phase marked PROGRAM THIS BLOCK NOW.`,
      `Roadmap:`,
      ...phaseLines,
      `Phase to program now: "${t.phase}"`,
      ...(t.focus ? [`  Focus: ${t.focus}`] : []),
      ...(t.lifting ? [`  Lifting: ${t.lifting}`] : []),
      ...(t.running ? [`  Running: ${t.running}`] : []),
      ...(t.nutrition ? [`  Nutrition: ${t.nutrition}`] : []),
    ].join("\n");
  }

  const targetLine = targetIndex >= roadmap.length
    ? "Every phase of the previous roadmap is complete — plan the next logical block that follows it " +
      "(e.g. the next build toward a remaining/new event, or a post-event transition), NOT a restart at Base."
    : `The athlete is currently in "${roadmap[targetIndex].phase}" — continue from there.`;
  return [
    `Previous plan (REDESIGN it because ${params.reason}, but CONTINUE from where the athlete is — do not`,
    `restart the periodization from the first phase or repeat COMPLETED phases):`,
    `Previous roadmap:`,
    ...phaseLines,
    targetLine,
  ].join("\n");
}

/**
 * A stored roadmap in the shape programSchema requires — older programs'
 * phases predate startDate/endDate, which the schema needs present (null).
 */
export function normalizeRoadmap<T extends RoadmapPhaseForContinuation>(roadmap: T[] | null | undefined) {
  return (roadmap ?? []).map((p) => ({
    ...p,
    dates: p.dates ?? "",
    startDate: p.startDate ?? null,
    endDate: p.endDate ?? null,
    focus: p.focus ?? "",
    lifting: p.lifting ?? "",
    running: p.running ?? null,
    nutrition: p.nutrition ?? null,
  }));
}
