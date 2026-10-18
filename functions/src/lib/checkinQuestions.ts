// The check-in's questions, now only about the data itself: "Welcome back"
// after a long gap since the plan last read the logs, and a nudge to import
// when Hevy has nothing new since then. Why the week went the way it did is
// the athlete's to say in a note ("Something not right?" here, "Not right?"
// on the Program page); the plan update compares the logs with the plan
// itself (generate/groundingData.ts). Each question is a fixed template, so
// no AI writes them.
// Pure, no Firebase imports; checkin/checkinQuestions.ts loads the data and
// saves answers as feedback notes for the next plan update.
import { addDays, daysBetween, dayOrDate, plural } from "./checkinFormat";

export interface CheckinInput {
  /** The athlete's local date, YYYY-MM-DD. */
  today: string;
  /** When the current plan last read the logs (YYYY-MM-DD, the athlete's date), or null with no plan. */
  planReadDate: string | null;
  /** The plan has lifting in it, so Hevy is where its sessions show up. */
  planHasLifts: boolean;
  /** used: Hevy is the athlete's strength log. lastSessionDate: the newest workout imported. */
  hevy: { used: boolean; lastSessionDate: string | null };
  /** Days with training logged since the plan read the logs (Hevy workouts, intervals.icu activities), YYYY-MM-DD. */
  trainedDates: string[];
}

export const QUESTION_KINDS = ["long_gap", "no_new_data"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface AnswerOption {
  id: string;
  label: string;
  /** Offers an optional "anything to add?" box before it's saved. */
  details?: true;
  /** Handled on the page, never saved: open the Hevy import, or hide the card. */
  action?: "import" | "dismiss";
}

export interface CheckinQuestion {
  /** Stable across loads, so an answer is matched to its question and not asked again. */
  key: string;
  kind: QuestionKind;
  /** The small line above the question. */
  source: string;
  text: string;
  answers: AnswerOption[];
  /** The blanks the answer's guidance to the update uses. */
  params: Record<string, string>;
}

interface PlanSession { exercises?: Array<{ name?: string; reps?: string; rir?: string }> }

/**
 * Whether a plan has lifting in it, so Hevy is where its sessions show up.
 * Rest and conditioning (a run, "30 min" of anything, which has no RIR) don't count.
 */
export function planHasLifts(sessions: PlanSession[] | null | undefined): boolean {
  return (sessions ?? []).some((s) => (s.exercises ?? []).some((ex) => ex.name && !/^rest(\s|$)/i.test(ex.name)
    && `${ex.rir ?? ""}`.trim().toLowerCase() !== "n/a"
    && !/\d\s*(km|k|mi|miles?|m|min|mins|minutes|h|hr|hrs|hours?)\b/i.test(ex.reps ?? "")));
}

/** A gap this long since the plan last read the logs opens with "Welcome back". */
export const LONG_GAP_DAYS = 14;
/** Hevy is only stale once a few days have passed with nothing new. */
const STALE_DAYS = 3;
const RECENT_DAYS = 7;

function answersFor(kind: QuestionKind): AnswerOption[] {
  switch (kind) {
    case "long_gap":
      return [{ id: "holiday", label: "Holiday" }, { id: "injured", label: "Injured or sick", details: true }, { id: "busy", label: "Busy" }, { id: "unlogged", label: "Trained, didn't log" }];
    case "no_new_data":
      return [{ id: "import", label: "Import now", action: "import" }, { id: "rest", label: "I didn't lift" }, { id: "skip", label: "Skip", action: "dismiss" }];
  }
}

/**
 * What the next plan update should do with an answer, in the app's own
 * words (the athlete's own text travels separately, as quoted data). Null
 * for an answer that isn't one of the question's, or that is never saved.
 */
export function answerGuidance(q: CheckinQuestion, answerId: string): string | null {
  const answer = q.answers.find((a) => a.id === answerId);
  if (!answer || answer.action) return null;
  const p = q.params;
  const g: Record<QuestionKind, Record<string, string>> = {
    long_gap: {
      holiday: `Back after ${p.weeks} away on holiday: ease them back in with a lighter first week.`,
      injured: `Back after ${p.weeks} injured or sick: rebuild gently with lighter loads and volume.`,
      busy: `Back after ${p.weeks} of little training: ease them back in with a lighter first week.`,
      unlogged: `They trained the last ${p.weeks} but didn't log it: keep loads where they were.`,
    },
    no_new_data: {
      rest: `No lifting since the last update: treat it as a rest week and don't progress loads.`,
    },
  };
  return g[q.kind][answerId] ?? null;
}

function question(kind: QuestionKind, key: string, source: string, text: string, params: Record<string, string> = {}): CheckinQuestion {
  return { key, kind, source, text, answers: answersFor(kind), params };
}

// Hevy has a workout from the days since the plan read the log (at most the last week).
function hevyFresh({ today, planReadDate, hevy }: CheckinInput): boolean {
  const weekAgo = addDays(today, -(RECENT_DAYS - 1));
  const since = planReadDate && planReadDate > weekAgo ? planReadDate : weekAgo;
  return hevy.lastSessionDate != null && hevy.lastSessionDate >= since;
}

/**
 * Training was logged often enough since the plan read the logs that no
 * stretch without any reaches a long gap: they weren't away, and the update
 * reads what they did. One run after three weeks off still leaves the gap.
 */
function gapCovered({ today, planReadDate, trainedDates }: CheckinInput): boolean {
  if (!planReadDate) return false;
  let last = planReadDate;
  for (const d of [...new Set(trainedDates)].filter((d) => d > planReadDate && d <= today).sort()) {
    if (daysBetween(last, d) >= LONG_GAP_DAYS) return false;
    last = d;
  }
  return daysBetween(last, today) < LONG_GAP_DAYS;
}

/**
 * Keys of questions for this plan whose premise the logs have since
 * disproved: Welcome back once the gap turns out to have been trained
 * through, "nothing new from Hevy" once workouts arrive. A waiting answer
 * to one of these is taken back rather than sent to the update.
 */
export function disprovedQuestionKeys(input: CheckinInput): string[] {
  const { today, planReadDate } = input;
  if (!planReadDate) return [];
  const keys: string[] = [];
  if (daysBetween(planReadDate, today) >= LONG_GAP_DAYS && gapCovered(input)) keys.push(`long_gap|${planReadDate}`);
  if (hevyFresh(input)) keys.push(`no_new_data|${planReadDate}`);
  return keys;
}

/** The questions for this check-in, welcome back first. */
export function buildCheckinQuestions(input: CheckinInput): CheckinQuestion[] {
  const { today, planReadDate } = input;
  if (!planReadDate) return [];
  const out: CheckinQuestion[] = [];

  const gapDays = daysBetween(planReadDate, today);
  if (gapDays >= LONG_GAP_DAYS && !gapCovered(input)) {
    const weeks = plural(Math.round(gapDays / 7), "week");
    out.push(question("long_gap", `long_gap|${planReadDate}`, "Welcome back",
      `It's been ${weeks} since your plan was last updated. What happened?`, { weeks }));
  }

  const since = planReadDate > addDays(today, -(RECENT_DAYS - 1)) ? planReadDate : addDays(today, -(RECENT_DAYS - 1));
  if (input.hevy.used && input.planHasLifts && !hevyFresh(input) && daysBetween(since, today) >= STALE_DAYS) {
    out.push(question("no_new_data", `no_new_data|${planReadDate}`, "Hevy",
      `No new Hevy workouts since ${dayOrDate(planReadDate, today)}, when your plan was last updated.`));
  }
  return out;
}
