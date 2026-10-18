// The check-in's one-tap questions: compare what the plan prescribed with
// what the Hevy log and intervals.icu activities show, and ask only about
// the differences. Each scenario has one fixed template whose blanks are
// filled from the logs and the plan (checkinFormat.ts), so no AI writes the
// questions. Rules (see the "Check-in scenarios" mockups):
// - Differences only; a week that went to plan asks nothing.
// - The last 7 days in detail; older weeks only as patterns ("3 of 4 weeks").
// - At most 3 questions shown, ranked; the rest behind "Show more".
// - No data, no question: a blank that can't be filled drops the question.
// - A gap of 2+ weeks opens with one "welcome back" question instead of
//   questions about every missed session.
// Pure, no Firebase imports; checkin/checkinQuestions.ts loads the data and
// saves answers as feedback notes for the next plan update.
import { WEEKDAYS, Weekday, normalizeDay } from "./days";
import type { StrengthSession, HevySet } from "./hevyDerivedData";
import { exercisesMatch } from "./trainingLog";
import {
  Units, Amount, addDays, daysBetween, dayOrDate, shortDate, doneOfPlanned, formatDistance, formatDuration, formatLoad,
  plural, possessive, timesWord, weekdayOf,
} from "./checkinFormat";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlanExercise {
  name?: string;
  sets?: number;
  reps?: string;
  rir?: string;
  load_note?: string | null;
}

export interface PlanSession {
  day: string;
  label?: string;
  exercises?: PlanExercise[];
}

export interface CheckinPlan {
  sessions?: PlanSession[] | null;
  /** Swaps made with "Not right?" on the Program page (exerciseSwap.ts): never asked about again. */
  swaps?: Array<{ day: string; from?: { name?: string }; to?: { name?: string } }> | null;
}

export interface LoggedActivity {
  id: string;
  date: string | null;
  type: string;
  name?: string | null;
  distance_km: number | null;
  duration_s: number | null;
  avg_hr: number | null;
  hrZones: number[] | null;
}

export interface CheckinInput {
  /** The athlete's local date, YYYY-MM-DD. */
  today: string;
  /** When the current plan last read the logs (YYYY-MM-DD, the athlete's date), or null with no plan. */
  planReadDate: string | null;
  /**
   * When the plan's current week structure began (its block start), so a
   * pattern isn't judged against weeks an older plan laid out differently.
   */
  planSince: string | null;
  plan: CheckinPlan | null;
  fixedSessions: Array<{ day: string; activity: string }>;
  /** Hevy sessions from about the last 5 weeks. */
  strength: StrengthSession[];
  /** intervals.icu activities from about the last 5 weeks. */
  activities: LoggedActivity[];
  /** Training form (TSB) from intervals.icu, or null. */
  tsb: number | null;
  /**
   * lastSessionDate: the newest workout imported. importedDate: the day of
   * the last import (the athlete's date); a later lift isn't in Hevy data yet.
   */
  hevy: { used: boolean; lastSessionDate: string | null; importedDate: string | null };
  icuConnected: boolean;
  units?: Units;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export const QUESTION_KINDS = [
  "swapped_exercise", "swapped_session", "moved_session", "skipped", "fell_short", "too_easy", "added", "cut_short", "off_zone",
  "class_missing", "extra_activity", "pattern", "fatigue", "long_gap", "no_new_data", "odd_entry",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface AnswerOption {
  id: string;
  label: string;
  /** Opens the pain questions (where, how bad, how long) before it's saved. */
  pain?: true;
  /** Offers an optional "anything to add?" box before it's saved. */
  details?: true;
  /** A second one-tap question before it's saved. */
  followUp?: { text: string; answers: Array<{ id: string; label: string }> };
  /** Handled on the page, never saved: open the Hevy import, or hide the card. */
  action?: "import" | "dismiss";
}

export interface CheckinQuestion {
  /** Stable across loads, so an answer is matched to its question and not asked again. */
  key: string;
  kind: QuestionKind;
  /** "gap" opens the check-in, "data" comes before the week, "week" is the ranked list. */
  group: "gap" | "data" | "week";
  /** The small line above the question, e.g. "Hevy · Monday". */
  source: string;
  text: string;
  /** Planned vs done, shown under the question. */
  facts: string[];
  answers: AnswerOption[];
  /** The exercise and day a note about this question is about. */
  exercise: string | null;
  day: Weekday | null;
  /** The blanks the answer's guidance to the update uses. */
  params: Record<string, string>;
  /** Lower is asked first. */
  rank: number;
  /** The date it's about, for ordering (most recent first). */
  date: string;
}

export interface CheckinQuestions {
  gap: CheckinQuestion | null;
  data: CheckinQuestion[];
  /** Up to MAX_SHOWN, most important first. */
  week: CheckinQuestion[];
  /** Behind "Show more", up to MAX_MORE. */
  more: CheckinQuestion[];
}

export const MAX_SHOWN = 3;
export const MAX_MORE = 6;
/** A gap this long since the plan last read the logs opens with "Welcome back". */
export const LONG_GAP_DAYS = 14;
const DETAIL_DAYS = 7;
const PATTERN_WEEKS = 4;
const PATTERN_MIN_MISSES = 3;
const FATIGUE_TSB = -20;

// ---------------------------------------------------------------------------
// Reading the plan and the logs
// ---------------------------------------------------------------------------

type Sport = "run" | "ride" | "row" | "swim" | "walk" | "strength" | "other";

const SPORT_NOUN: Record<Sport, string> = {
  run: "run", ride: "ride", row: "row", swim: "swim", walk: "walk", strength: "strength workout", other: "workout",
};

export function activitySport(type: string): Sport {
  const t = type.toLowerCase();
  if (/run/.test(t)) return "run";
  if (/ride|bike|cycl/.test(t)) return "ride";
  if (/row/.test(t)) return "row";
  if (/swim/.test(t)) return "swim";
  if (/walk|hike/.test(t)) return "walk";
  if (/weight|strength|crossfit|workout/.test(t)) return "strength";
  return "other";
}

function plannedSport(ex: PlanExercise): Sport {
  const n = `${ex.name ?? ""}`.toLowerCase();
  if (/\brun|jog/.test(n)) return "run";
  if (/ride|bike|cycl/.test(n)) return "ride";
  if (/\brow/.test(n)) return "row";
  if (/swim/.test(n)) return "swim";
  if (/walk|hike/.test(n)) return "walk";
  return "other";
}

/** "14 km", "5k", "30 min", "1 h": a planned distance or time, or nulls. */
export function parseAmount(reps: string | undefined): Amount {
  const s = (reps ?? "").toLowerCase();
  const dist = s.match(/(\d+(?:\.\d+)?)\s*(km|k|mi|miles?|m)\b/);
  const time = s.match(/(\d+(?:\.\d+)?)\s*(min|mins|minutes|h|hr|hrs|hours?)\b/);
  let km: number | null = null;
  if (dist) {
    const n = Number(dist[1]);
    km = dist[2] === "m" ? n / 1000 : /^mi/.test(dist[2]) ? n * 1.609344 : n;
  }
  const seconds = time ? Number(time[1]) * (/^h/.test(time[2]) ? 3600 : 60) : null;
  return { km, seconds };
}

/** A conditioning entry (a run, a ride, "30 min" of anything) rather than a lift. */
function isConditioning(ex: PlanExercise): boolean {
  const amount = parseAmount(ex.reps);
  return (ex.rir ?? "").trim().toLowerCase() === "n/a" || amount.km != null || amount.seconds != null;
}

const isRest = (ex: PlanExercise) => /^rest(\s|$)/i.test(ex.name ?? "");

/** "6-8" → [6, 8]; "8" → [8, 8]; "AMRAP" → null. */
export function repRange(reps: string | undefined): [number, number] | null {
  const m = (reps ?? "").match(/^\s*(\d+)\s*(?:[-–to]+\s*(\d+))?/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  return lo > 0 && hi >= lo ? [lo, hi] : null;
}

interface PlannedDay {
  label: string;
  lifts: PlanExercise[];
  cardio: PlanExercise[];
}

function planByWeekday(plan: CheckinPlan | null): Map<Weekday, PlannedDay> {
  const out = new Map<Weekday, PlannedDay>();
  for (const s of plan?.sessions ?? []) {
    const day = normalizeDay(s.day);
    if (!day) continue;
    const exercises = (s.exercises ?? []).filter((ex) => ex.name && !isRest(ex));
    if (!exercises.length) continue;
    const cur = out.get(day) ?? { label: s.label?.trim() || "planned", lifts: [], cardio: [] };
    for (const ex of exercises) (isConditioning(ex) ? cur.cardio : cur.lifts).push(ex);
    out.set(day, cur);
  }
  return out;
}

const workingSets = (sets: HevySet[]) => sets.filter((s) => s.type !== "warmup");

function formatSets(sets: HevySet[], units: Units): string {
  return sets.map((s) => (s.weight_kg ? `${formatLoad(s.weight_kg, units)} × ${s.reps ?? "?"}` : `${s.reps ?? "?"} reps`)).join(", ");
}

/** "a 5 km run", "a 45 min ride". */
function describeActivity(a: LoggedActivity, units: Units): string {
  const noun = SPORT_NOUN[activitySport(a.type)];
  const amount = a.distance_km ? `${formatDistance(a.distance_km, units)} ` : a.duration_s ? `${formatDuration(a.duration_s)} ` : "";
  const text = `${amount}${noun === "workout" && a.name ? a.name : noun}`;
  return `${/^[aeiou8]/i.test(text) ? "an" : "a"} ${text}`;
}

/** "Long run" → "long run", but "Hyrox Sim" and "SkiErg" stay as they are. */
const lowerFirst = (s: string) => (/^[A-Z][^A-Z]*$/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

const sessionName = (label: string) => (/session$/i.test(label) ? label : `${label} session`);

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const PAIN_ANSWER = (label: string): AnswerOption => ({ id: "hurt", label, pain: true });

function answersFor(kind: QuestionKind, p: Record<string, string>): AnswerOption[] {
  switch (kind) {
    case "swapped_exercise":
      return [{ id: "no_equipment", label: "No equipment" }, PAIN_ANSWER("It hurt"), { id: "prefer", label: "Prefer it" }, { id: "once", label: "Just this once" }];
    case "swapped_session":
      return [
        { id: "time", label: "Short on time" },
        PAIN_ANSWER("It hurt"),
        { id: "prefer", label: "Prefer this activity", followUp: { text: "Make it regular?", answers: [{ id: "yes", label: `Yes, every ${p.day}` }, { id: "no", label: "No, just this week" }] } },
        { id: "once", label: "Just this once" },
      ];
    case "moved_session":
      return [{ id: "once", label: "Just this week" }, { id: "regular", label: `Move it to ${p.day}s` }];
    case "skipped":
      return [{ id: "busy", label: "Busy" }, { id: "tired", label: "Too tired" }, PAIN_ANSWER("Sore or hurt"), { id: "logged", label: "Did it, didn't log it" }];
    case "fell_short":
      return [{ id: "heavy", label: "Too heavy" }, { id: "bad_day", label: "Bad day" }, PAIN_ANSWER("It hurt")];
    case "too_easy":
      return [{ id: "push", label: "Push it" }, { id: "steady", label: "Keep it steady" }];
    case "added":
      return [{ id: "add", label: "Add it to my plan" }, { id: "extra", label: "Just extra" }];
    case "cut_short":
      return [{ id: "time", label: "Ran out of time" }, { id: "tired", label: "Too tired" }, PAIN_ANSWER("Something hurt"), { id: "planned", label: "Planned it that way" }];
    case "off_zone":
      return [{ id: "fine", label: "Felt fine" }, { id: "heat", label: "Hot or humid" }, { id: "struggled", label: "Struggled" }];
    case "class_missing":
      return [{ id: "skipped", label: "Skipped it" }, { id: "unrecorded", label: "Went, not recorded" }, { id: "cancelled", label: "Class cancelled" }];
    case "extra_activity":
      return [{ id: "regular", label: "Make it regular" }, { id: "once", label: "Just this once" }];
    case "pattern":
      return [
        { id: "move", label: "Move it", followUp: { text: "Move it to", answers: WEEKDAYS.filter((d) => d !== p.day).map((d) => ({ id: d, label: d.slice(0, 3) })) } },
        { id: "drop", label: "Drop it" },
        { id: "keep", label: "Keep it" },
      ];
    case "fatigue":
      return [{ id: "ease", label: "Ease off this week" }, { id: "ill", label: "Run down or ill" }, { id: "fine", label: "I feel fine" }];
    case "long_gap":
      return [{ id: "holiday", label: "Holiday" }, { id: "injured", label: "Injured or sick", details: true }, { id: "busy", label: "Busy" }, { id: "unlogged", label: "Trained, didn't log" }];
    case "no_new_data":
      return [{ id: "import", label: "Import now", action: "import" }, { id: "rest", label: "I didn't lift" }, { id: "skip", label: "Skip", action: "dismiss" }];
    case "odd_entry":
      return [{ id: "typo", label: "It's a typo, ignore it" }, { id: "right", label: "It's right" }];
  }
}

/**
 * What the next plan update should do with an answer, in the app's own
 * words (the athlete's own text travels separately, as quoted data). Null
 * for an answer that isn't one of the question's, or that is never saved.
 * A pain answer's guidance only frames it; the pain note's own handling
 * (planFeedback.ts) does the rest.
 */
export function answerGuidance(q: CheckinQuestion, answerId: string, followUpId: string | null): string | null {
  const answer = q.answers.find((a) => a.id === answerId);
  if (!answer || answer.action) return null;
  if (answer.followUp && !answer.followUp.answers.some((f) => f.id === followUpId)) return null;
  const p = q.params;
  if (answer.pain) return `It hurt: work around it as the pain item describes.`;
  const g: Record<QuestionKind, Record<string, string>> = {
    swapped_exercise: {
      no_equipment: `They have no equipment for ${p.planned}: replace it, e.g. with ${p.logged}, using what they have.`,
      prefer: `They prefer ${p.logged}: make it the plan's exercise in place of ${p.planned} on ${p.day}.`,
      once: `A one-off: keep ${p.planned}.`,
    },
    swapped_session: {
      time: `Short on time for the ${p.session} on ${p.day}: make it fit a shorter slot, keeping its key lifts.`,
      prefer: followUpId === "yes"
        ? `Make ${p.activity} the regular ${p.day} session and move the ${p.session} work to another day if the week still works (spacing, fixed sessions, the block's goal). If it doesn't, keep the ${p.session} on ${p.day} and say why in the response.`
        : `A one-off: keep the plan.`,
      once: `A one-off: keep the plan.`,
    },
    moved_session: {
      once: `They did the ${p.session} on ${p.day} instead of ${p.from} this week: a one-off, keep it on ${p.from}.`,
      regular: `Move the ${p.session} from ${p.from} to ${p.day} if the week still works (spacing, fixed sessions, the block's goal); include both days in sessions. If it doesn't, keep it on ${p.from} and say why in the response.`,
    },
    skipped: {
      busy: `Missed for lack of time: a one-off unless it keeps happening; keep the week.`,
      tired: `Missed through tiredness: ease this week's volume a little.`,
      logged: `They did it but didn't log it: treat it as done.`,
    },
    fell_short: {
      heavy: `Too heavy: lower the load for ${p.exercise} so they hit the reps.`,
      bad_day: `A bad day: hold the load for ${p.exercise}.`,
    },
    too_easy: {
      push: `Progress ${p.exercise} faster (load or reps).`,
      steady: `Hold ${p.exercise} where it is.`,
    },
    added: {
      add: `Write ${p.exercise} into the week where it fits.`,
      extra: `Leave ${p.exercise} out of the plan; it's extra work they choose to do.`,
    },
    cut_short: {
      time: `Ran out of time: shorten or move the ${p.activity} so it fits.`,
      tired: `Too tired: ease off this week.`,
      planned: `Shortened on purpose: no change needed.`,
    },
    off_zone: {
      fine: `Felt fine above zone 2: their zones may be set low; don't slow the targets.`,
      heat: `The heat, not their fitness: no change.`,
      struggled: `Struggled: slow the easy-run target and ease off a little.`,
    },
    class_missing: {
      skipped: `They skipped the ${p.activity}: count it as missed when judging training load.`,
      unrecorded: `They went to the ${p.activity} but didn't record it: count it as done.`,
      cancelled: `The ${p.activity} was cancelled: count it as missed, not their choice.`,
    },
    extra_activity: {
      regular: `Treat ${p.activity} on ${p.day} as a regular fixed session and plan around it.`,
      once: `A one-off: no change.`,
    },
    pattern: {
      move: `Move the ${p.session} from ${p.day} to ${followUpId} if the week still works; include both days in sessions.`,
      drop: `Drop the ${p.session} on ${p.day} and make ${p.day} a rest day, keeping its most important work elsewhere in the week.`,
      keep: `Keep the week as it is.`,
    },
    fatigue: {
      ease: `Write a lighter week (about a third less volume), then build back.`,
      ill: `They're run down or ill: write an easy week with no hard sessions.`,
      fine: `They feel fine: carry on as planned.`,
    },
    long_gap: {
      holiday: `Back after ${p.weeks} away on holiday: ease them back in with a lighter first week.`,
      injured: `Back after ${p.weeks} injured or sick: rebuild gently with lighter loads and volume.`,
      busy: `Back after ${p.weeks} of little training: ease them back in with a lighter first week.`,
      unlogged: `They trained the last ${p.weeks} but didn't log it: keep loads where they were.`,
    },
    no_new_data: {
      rest: `No lifting since the last update: treat it as a rest week and don't progress loads.`,
    },
    odd_entry: {
      typo: `The ${p.exercise} set of ${p.value} on ${p.day} is a logging error: ignore it.`,
      right: `The ${p.exercise} set of ${p.value} on ${p.day} is real.`,
    },
  };
  return g[q.kind][answerId] ?? null;
}

// ---------------------------------------------------------------------------
// Building the questions
// ---------------------------------------------------------------------------

const RANK: Record<QuestionKind, number> = {
  long_gap: 0, no_new_data: 0, odd_entry: 0,
  pattern: 1,
  fatigue: 2, skipped: 2, swapped_session: 2, cut_short: 2, class_missing: 2,
  swapped_exercise: 3, moved_session: 3, fell_short: 3, off_zone: 3,
  too_easy: 4, added: 4, extra_activity: 4,
};

const GROUP: Partial<Record<QuestionKind, CheckinQuestion["group"]>> = {
  long_gap: "gap", no_new_data: "data", odd_entry: "data",
};

function question(
  kind: QuestionKind,
  key: string,
  date: string,
  source: string,
  text: string,
  opts: { facts?: string[]; exercise?: string | null; day?: Weekday | null; params?: Record<string, string> } = {}
): CheckinQuestion {
  const params = opts.params ?? {};
  return {
    key, kind, group: GROUP[kind] ?? "week", source, text, facts: opts.facts ?? [],
    answers: answersFor(kind, params), exercise: opts.exercise ?? null, day: opts.day ?? null,
    params, rank: RANK[kind], date,
  };
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/** Plan labels and workout titles as words, without the generic ones ("Legs day" → leg). */
function titleWords(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w && !/^(day|session|workout|training|a|b|c|\d+)$/.test(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));
}

const sameWords = (a: Set<string>, b: Set<string>) => a.size > 0 && a.size === b.size && [...a].every((w) => b.has(w));

export function buildCheckinQuestions(input: CheckinInput): CheckinQuestions {
  const units = input.units ?? "metric";
  const { today } = input;
  const planned = planByWeekday(input.plan);
  const fixedByDay = new Map<Weekday, string[]>();
  for (const f of input.fixedSessions) {
    const day = normalizeDay(f.day);
    if (day && f.activity?.trim()) fixedByDay.set(day, [...(fixedByDay.get(day) ?? []), f.activity.trim()]);
  }
  const swapped = (day: Weekday, name: string) => (input.plan?.swaps ?? []).some((s) =>
    normalizeDay(s.day) === day && [s.from?.name, s.to?.name].some((n) => n && exercisesMatch(n, name)));

  const gapDays = input.planReadDate ? daysBetween(input.planReadDate, today) : null;
  const longGap = gapDays != null && gapDays >= LONG_GAP_DAYS;
  // The last 7 days including today, so a day name always means one date.
  const weekStart = addDays(today, -(DETAIL_DAYS - 1));
  const detailStart = input.planReadDate ? maxDate(input.planReadDate, weekStart) : weekStart;

  const strengthOn = (date: string) => input.strength.filter((s) => s.date === date);
  const activitiesOn = (date: string) => input.activities.filter((a) => a.date === date);
  // Hevy is the strength log when it's in use; without fresh data in the
  // window, a missing lift is unknown, not skipped.
  const hevyFresh = input.hevy.used && input.hevy.lastSessionDate != null && input.hevy.lastSessionDate >= detailStart;
  // Hevy comes in by CSV upload, so a day after the last import is unknown.
  const liftsKnownOn = (date: string) => input.hevy.used
    ? hevyFresh && input.hevy.importedDate != null && date <= input.hevy.importedDate
    : input.icuConnected;

  const week: CheckinQuestion[] = [];
  const data: CheckinQuestion[] = [];
  const added = new Map<string, { count: number; last: string }>();

  // How well workouts fit a planned day, as the share of its lifts they
  // cover (one logged exercise per planned lift), needing at least half; or
  // by a title that is the plan's label ("Legs" for "Legs day"). 0 if neither.
  function fitScore(plan: PlannedDay, logs: StrengthSession[]): number {
    const logged = logs.flatMap((s) => s.exercises).filter((ex) => workingSets(ex.sets).length > 0);
    const usedLogged = new Set<number>();
    let matched = 0;
    for (const p of plan.lifts) {
      const i = logged.findIndex((l, idx) => !usedLogged.has(idx) && exercisesMatch(p.name!, l.name));
      if (i !== -1) { usedLogged.add(i); matched++; }
    }
    const share = matched / plan.lifts.length;
    const label = titleWords(plan.label);
    const titled = logs.some((s) => sameWords(titleWords(s.title ?? ""), label));
    return share >= 0.5 || titled ? share + (titled ? 0.1 : 0) : 0;
  }

  type Pairing = {
    /** Workouts done for another day's planned session → that day and its date. */
    moved: Map<StrengthSession, { day: Weekday; date: string }>;
    /** Workouts that may be a session still to come, done early in part: not asked about yet. */
    early: Set<StrengthSession>;
  };

  // A planned lift session done on another day of the same Monday-to-Sunday
  // week is that session moved, not a skip plus an extra workout. Each
  // workout goes to the planned session it fits best, best fits first, its
  // own day's session winning a tie; one that fits nothing is left to the
  // usual checks. Only days from doneFrom on count, so neither a workout nor
  // a planned day an older plan already saw is paired.
  function pairWeek(monday: string, doneFrom: string | null): Pairing {
    const options: Array<{ s: StrengthSession; day: Weekday; date: string; score: number; own: boolean }> = [];
    const early = new Set<StrengthSession>();
    for (let i = 0; i < 7; i++) {
      const done = addDays(monday, i);
      if (done > today || (doneFrom && done < doneFrom)) continue;
      for (const s of strengthOn(done)) {
        for (const [day, plan] of planned) {
          const date = addDays(monday, WEEKDAYS.indexOf(day));
          if (!plan.lifts.length || (doneFrom && date < doneFrom)) continue;
          const score = fitScore(plan, [s]);
          if (!score) continue;
          const own = day === weekdayOf(done);
          // A session still to come today or later is only done early if all of it was.
          if (!own && date >= today && score < 1) { early.add(s); continue; }
          options.push({ s, day, date, score, own });
        }
      }
    }
    options.sort((a, b) => b.score - a.score || Number(b.own) - Number(a.own));
    const takenDay = new Set<Weekday>();
    const placed = new Set<StrengthSession>();
    const moved = new Map<StrengthSession, { day: Weekday; date: string }>();
    for (const o of options) {
      if (placed.has(o.s) || takenDay.has(o.day)) continue;
      placed.add(o.s);
      takenDay.add(o.day);
      if (!o.own) moved.set(o.s, { day: o.day, date: o.date });
    }
    for (const s of placed) early.delete(s);
    return { moved, early };
  }
  const mondayOf = (date: string) => addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
  const moved = new Map<StrengthSession, { day: Weekday; date: string }>();
  const early = new Set<StrengthSession>();
  for (let monday = mondayOf(detailStart); monday <= today; monday = addDays(monday, 7)) {
    const pairing = pairWeek(monday, input.planReadDate);
    pairing.moved.forEach((to, s) => moved.set(s, to));
    pairing.early.forEach((s) => early.add(s));
  }
  // Planned dates whose session was done on another day.
  const doneElsewhere = new Set([...moved.values()].map((m) => m.date));

  for (let date = detailStart; date <= today; date = addDays(date, 1)) {
    const day = weekdayOf(date);
    const past = date < today; // today's session may still be ahead
    const label = dayOrDate(date, today);
    // The day's own plan, unless its session was done on another day.
    const plan = doneElsewhere.has(date) ? undefined : planned.get(day);
    // Workouts done today for other days' sessions, by the day they were planned for.
    const movedHere = new Map<Weekday, { date: string; logs: StrengthSession[] }>();
    for (const s of strengthOn(date)) {
      const to = moved.get(s);
      if (to) movedHere.set(to.day, { date: to.date, logs: [...(movedHere.get(to.day)?.logs ?? []), s] });
    }
    // The rest are the day's own, or extra.
    const logs = strengthOn(date).filter((s) => !moved.has(s));
    // A Hevy workout synced to intervals.icu is the same workout twice.
    const acts = activitiesOn(date).filter((a) => !(strengthOn(date).length && activitySport(a.type) === "strength"));
    const used = new Set<string>();
    const unusedActs = () => acts.filter((a) => !used.has(a.id));
    const cardioActs = () => unusedActs().filter((a) => activitySport(a.type) !== "strength");

    // Planned cardio first: its matching activity is spoken for. A moved
    // session's cardio counts on its planned day and, if not done there, on
    // the day its lifts were done.
    const doneOn = (ex: PlanExercise, d: string) => activitiesOn(d).some((a) => {
      const sport = plannedSport(ex);
      return activitySport(a.type) !== "strength" && (sport === "other" || activitySport(a.type) === sport);
    });
    const ownCardio = planned.get(day)?.cardio ?? [];
    const cardio = [
      ...ownCardio.map((ex) => ({ ex, owner: planned.get(day)!, ownerDay: day })),
      ...[...movedHere].flatMap(([d, m]) => planned.get(d)!.cardio
        .filter((ex) => !doneOn(ex, m.date)).map((ex) => ({ ex, owner: planned.get(d)!, ownerDay: d }))),
    ];
    for (const { ex, owner, ownerDay } of cardio) {
      if (!input.icuConnected) break;
      const sport = plannedSport(ex);
      const match = cardioActs().find((a) => sport === "other" || activitySport(a.type) === sport);
      if (!match) continue;
      used.add(match.id);
      const doneText = doneOfPlanned({ km: match.distance_km, seconds: match.duration_s }, parseAmount(ex.reps), units);
      const plannedAmount = parseAmount(ex.reps);
      const ratio = plannedAmount.km != null && match.distance_km != null ? match.distance_km / plannedAmount.km
        : plannedAmount.seconds != null && match.duration_s != null ? match.duration_s / plannedAmount.seconds : null;
      // A run-only day reads better by its session name ("long run") than by its exercise.
      const name = owner.lifts.length === 0 && owner.cardio.length === 1 ? owner.label : ex.name ?? "session";
      const activity = lowerFirst(name);
      if (doneText && ratio != null && ratio < 0.75) {
        week.push(question("cut_short", `cut_short|${date}|${name}`, date, `intervals.icu · ${label}`,
          `${possessive(label)} ${activity} was ${doneText}. Why?`,
          { exercise: ex.name ?? null, day: ownerDay, params: { activity, day } }));
      }
      const easy = /zone\s*2|\bz2\b|easy|recovery|aerobic/i.test(`${ex.name} ${ex.reps} ${ex.load_note ?? ""}`);
      const z2Top = match.hrZones?.[1];
      if (easy && match.avg_hr != null && z2Top != null && match.avg_hr > z2Top + 3) {
        week.push(question("off_zone", `off_zone|${date}|${name}`, date, `intervals.icu · ${label}`,
          `${possessive(label)} ${activity} averaged ${match.avg_hr} bpm, above zone 2. How did it feel?`,
          { facts: [`Zone 2 up to ${z2Top} bpm`, `Average ${match.avg_hr} bpm`], exercise: ex.name ?? null, day: ownerDay, params: { activity, day } }));
      }
    }

    for (const [fromDay, m] of movedHere) {
      const from = planned.get(fromDay)!;
      const session = sessionName(from.label);
      week.push(question("moved_session", `moved_session|${date}|${fromDay}`, date, `Hevy · ${label}`,
        `You did ${possessive(fromDay)} ${session} on ${label}. Why the move?`,
        { day: fromDay, params: { session, from: fromDay, day } }));
      compareLifts(from, m.logs, date, fromDay, label);
    }

    // Planned lifts.
    if (plan?.lifts.length) {
      if (logs.length) {
        compareLifts(plan, logs, date, day, label);
      } else if (unusedActs().some((a) => activitySport(a.type) === "strength")) {
        used.add(unusedActs().find((a) => activitySport(a.type) === "strength")!.id);
      } else if (past && liftsKnownOn(date)) {
        const other = cardioActs()[0];
        const session = sessionName(plan.label);
        if (other) {
          used.add(other.id);
          const activity = describeActivity(other, units);
          week.push(question("swapped_session", `swapped_session|${date}`, date, `intervals.icu · ${label}`,
            `You did ${activity} instead of your ${session} on ${label}. Why?`,
            { day, params: { activity, session, day } }));
        } else if (!longGap) {
          week.push(question("skipped", `skipped|${date}`, date, `Hevy · ${label}`,
            `${possessive(label)} ${session} isn't in your log. What happened?`,
            { day, params: { session, day } }));
        }
      }
    } else if (plan?.cardio.length && past && input.icuConnected) {
      // A cardio-only day with nothing that matched its plan.
      if (!acts.some((a) => used.has(a.id))) {
        const other = cardioActs()[0];
        const session = sessionName(plan.label);
        if (other) {
          used.add(other.id);
          const activity = describeActivity(other, units);
          week.push(question("swapped_session", `swapped_session|${date}`, date, `intervals.icu · ${label}`,
            `You did ${activity} instead of your ${session} on ${label}. Why?`,
            { day, params: { activity, session, day } }));
        } else if (!longGap && !logs.length) {
          week.push(question("skipped", `skipped|${date}`, date, `intervals.icu · ${label}`,
            `${possessive(label)} ${session} isn't in your log. What happened?`,
            { day, params: { session, day } }));
        }
      }
    }

    // Fixed sessions (classes): only intervals.icu would show them.
    for (const activity of fixedByDay.get(day) ?? []) {
      if (!input.icuConnected) break;
      const match = unusedActs()[0];
      if (match) { used.add(match.id); continue; }
      if (past && !longGap) {
        week.push(question("class_missing", `class_missing|${date}|${activity}`, date, `Fixed session · ${label}`,
          `No ${activity} on ${label}. What happened?`, { day, params: { activity, day } }));
      }
    }

    // Anything left over wasn't planned.
    for (const a of unusedActs()) {
      const sport = activitySport(a.type);
      const long = (a.duration_s ?? 0) >= (sport === "walk" ? 3600 : 1200);
      if (!long || sport === "strength") continue;
      const activity = describeActivity(a, units);
      week.push(question("extra_activity", `extra_activity|${a.id}`, date, `intervals.icu · ${label}`,
        `You added ${activity} on ${label}. Part of your week?`, { day, params: { activity, day } }));
    }
    if (!plan?.lifts.length) {
      for (const s of logs.filter((s) => !early.has(s))) {
        const activity = `your "${s.title}" workout`;
        week.push(question("extra_activity", `extra_activity|hevy|${date}|${s.title}`, date, `Hevy · ${label}`,
          `You added ${activity} on ${label}. Part of your week?`, { day, params: { activity, day } }));
      }
    }
    for (const s of strengthOn(date)) checkOddEntries(s, date, day, label);
  }

  // day is the weekday the session was planned for; label names when it was done.
  function compareLifts(plan: PlannedDay, logs: StrengthSession[], date: string, day: Weekday, label: string) {
    const logged = logs.flatMap((s) => s.exercises).filter((ex) => workingSets(ex.sets).length > 0);
    const usedLogged = new Set<number>();
    const unmatchedPlan: PlanExercise[] = [];
    for (const p of plan.lifts) {
      const i = logged.findIndex((l, idx) => !usedLogged.has(idx) && exercisesMatch(p.name!, l.name));
      if (i === -1) { unmatchedPlan.push(p); continue; }
      usedLogged.add(i);
      checkSets(p, logged[i].name, workingSets(logged[i].sets), date, day, label);
    }
    const unmatchedLogged = logged.filter((_, idx) => !usedLogged.has(idx));
    // Pair the leftovers in order: a planned lift with no match and a logged
    // lift that wasn't planned are most likely one swapped for the other.
    unmatchedLogged.forEach((l, i) => {
      const p = unmatchedPlan[i];
      if (p && !swapped(day, p.name!) && !swapped(day, l.name)) {
        week.push(question("swapped_exercise", `swapped_exercise|${date}|${p.name}`, date, `Hevy · ${label}`,
          `You did ${l.name} instead of ${p.name} on ${label}. Why?`,
          { exercise: p.name!, day, params: { planned: p.name!, logged: l.name, day } }));
      } else if (!p) {
        const cur = added.get(l.name) ?? { count: 0, last: date };
        added.set(l.name, { count: cur.count + 1, last: maxDate(cur.last, date) });
      }
    });
  }

  function checkSets(p: PlanExercise, loggedName: string, sets: HevySet[], date: string, day: Weekday, label: string) {
    const range = repRange(p.reps);
    const withReps = sets.filter((s) => s.reps != null);
    if (!range || withReps.length < 2) return;
    const [lo, hi] = range;
    const facts = [`Planned ${p.sets ?? "?"} × ${p.reps}`, `Did ${formatSets(withReps, units)}`];
    if (withReps.filter((s) => s.reps! < lo).length >= 2) {
      week.push(question("fell_short", `fell_short|${date}|${p.name}`, date, `Hevy · ${label}`,
        `${loggedName} fell short of ${lo} reps. How did it feel?`,
        { facts, exercise: p.name!, day, params: { exercise: loggedName, day } }));
    } else if (withReps.every((s) => s.reps! >= hi + 2)) {
      week.push(question("too_easy", `too_easy|${date}|${p.name}`, date, `Hevy · ${label}`,
        `You beat every ${loggedName} set. Ready for more?`,
        { facts, exercise: p.name!, day, params: { exercise: loggedName, day } }));
    }
  }

  // A set far heavier than anything logged for that exercise before is more
  // likely a typo than a 2.5× jump.
  function checkOddEntries(s: StrengthSession, date: string, day: Weekday, label: string) {
    for (const ex of s.exercises) {
      const before = input.strength.filter((o) => o.date < date)
        .flatMap((o) => o.exercises.filter((e) => e.name === ex.name))
        .flatMap((e) => workingSets(e.sets).map((set) => set.weight_kg ?? 0));
      if (before.length < 2) continue;
      const best = Math.max(...before);
      const odd = workingSets(ex.sets).find((set) => best > 0 && (set.weight_kg ?? 0) > best * 2.5);
      if (!odd) continue;
      const value = `${formatLoad(odd.weight_kg!, units)} × ${odd.reps ?? "?"}`;
      data.push(question("odd_entry", `odd_entry|${date}|${ex.name}|${odd.index}`, date, `Hevy · ${label} · looks off`,
        `${ex.name}: ${value}? That's far more than your best of ${formatLoad(best, units)}.`,
        { exercise: ex.name, day, params: { exercise: ex.name, value, day } }));
      return;
    }
  }

  for (const [name, { count, last }] of added) {
    if (count < 2) continue;
    week.push(question("added", `added|${input.planReadDate ?? "none"}|${name}`, last, "Hevy · this week",
      `You added ${name} ${timesWord(count)} this week. Keep it in?`, { exercise: name, params: { exercise: name } }));
  }

  // Patterns over the last 4 weeks replace the single skip they include.
  if (!longGap) {
    const firstLog = [...input.strength.map((s) => s.date), ...input.activities.map((a) => a.date ?? today)].sort()[0];
    for (const [day, plan] of planned) {
      const dates = Array.from({ length: PATTERN_WEEKS }, (_, w) => {
        let d = addDays(today, -1);
        while (weekdayOf(d) !== day) d = addDays(d, -1);
        return addDays(d, -7 * w);
      });
      if (!firstLog || firstLog > dates[dates.length - 1]) continue; // not enough history
      // Only weeks this plan's structure laid out, and only days the logs cover.
      const judged = dates.filter((d) => (!input.planSince || d >= input.planSince)
        && (plan.lifts.length ? liftsKnownOn(d) : input.icuConnected));
      if (judged.length < PATTERN_MIN_MISSES) continue;
      // A session done on another day of its week wasn't missed, and a day
      // whose only workout was another day's session wasn't trained.
      const weeks = new Map<string, Pairing>();
      const pairingOf = (d: string) => {
        const monday = mondayOf(d);
        if (!weeks.has(monday)) weeks.set(monday, pairWeek(monday, input.planSince));
        return weeks.get(monday)!;
      };
      const trained = (d: string) => activitiesOn(d).length > 0
        || strengthOn(d).some((s) => !(plan.lifts.length && pairingOf(d).moved.has(s)));
      const movedAway = (d: string) => plan.lifts.length > 0 && (doneElsewhere.has(d)
        || [...pairingOf(d).moved.values()].some((m) => m.date === d));
      const missed = judged.filter((d) => !trained(d) && !movedAway(d));
      if (missed.length < PATTERN_MIN_MISSES) continue;
      const session = sessionName(plan.label);
      for (let i = week.length - 1; i >= 0; i--) {
        if (week[i].kind === "skipped" && week[i].day === day) week.splice(i, 1);
      }
      week.push(question("pattern", `pattern|${day}|${plan.label}`, dates[0], `Pattern · last ${plural(judged.length, "week")}`,
        `${possessive(day)} ${session} was missed in ${missed.length} of the last ${plural(judged.length, "week")}.`,
        { facts: judged.slice().reverse().map((d) => `${shortDate(d)}: ${missed.includes(d) ? "missed" : "done"}`), day, params: { session, day } }));
    }
  }

  // Signs of fatigue: one question replaces the "fell short" cards.
  const short = week.filter((q) => q.kind === "fell_short");
  const offZone = week.filter((q) => q.kind === "off_zone");
  if (input.tsb != null && input.tsb <= FATIGUE_TSB && short.length + offZone.length >= 2 && short.length >= 1) {
    const facts = [`Form (TSB) ${input.tsb}`, `${plural(short.length, "lift")} short`];
    if (offZone.length) facts.push(`${plural(offZone.length, "run")} above zone 2`);
    const rest = week.filter((q) => q.kind !== "fell_short" && q.kind !== "off_zone");
    week.length = 0;
    week.push(...rest, question("fatigue", `fatigue|${input.planReadDate ?? "none"}`, today, "Hevy + intervals.icu · this week",
      `Your training load is high and ${plural(short.length, "lift")} fell short. How are you feeling?`, { facts }));
  }

  // Nothing new from Hevy since the plan read the log.
  const hasLifts = [...planned.values()].some((p) => p.lifts.length > 0);
  if (input.hevy.used && hasLifts && input.planReadDate && !hevyFresh && daysBetween(detailStart, today) >= 3) {
    data.unshift(question("no_new_data", `no_new_data|${input.planReadDate}`, today, "Hevy",
      `No new Hevy workouts since ${dayOrDate(input.planReadDate, today)}, when your plan was last updated.`));
  }

  let gap: CheckinQuestion | null = null;
  if (longGap) {
    const weeks = plural(Math.round(gapDays! / 7), "week");
    gap = question("long_gap", `long_gap|${input.planReadDate}`, today, "Welcome back",
      `It's been ${weeks} since your plan was last updated. What happened?`, { params: { weeks } });
  }

  const ranked = dedupe(week).sort((a, b) => a.rank - b.rank || b.date.localeCompare(a.date));
  return { gap, data: dedupe(data), week: ranked.slice(0, MAX_SHOWN), more: ranked.slice(MAX_SHOWN, MAX_SHOWN + MAX_MORE) };
}

function dedupe(qs: CheckinQuestion[]): CheckinQuestion[] {
  const seen = new Set<string>();
  return qs.filter((q) => (seen.has(q.key) ? false : (seen.add(q.key), true)));
}
