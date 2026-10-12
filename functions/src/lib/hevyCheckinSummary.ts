// The summaries the check-in screen shows after a Hevy import: an e1RM
// progression table and adherence to the active plan. Pure, no Firebase
// dependency: the browser computes these straight from the parsed CSV (see
// src/web/hevyCheckin.ts), so the athlete sees them without waiting on a save.
// Generation doesn't use these numbers — it reads the raw log instead (see
// lib/trainingLog.ts).
import { identifyKeyLifts, computeLiftProgression, PROGRESSION_CONFIG, StrengthSession } from "./hevyDerivedData";
import { exercisesMatch } from "./trainingLog";

/**
 * Build a client-facing progression summary (e1RM table) from parsed sessions.
 * Never throws: any computation failure degrades to null so a successful
 * import is never blocked.
 */
export function buildProgressionSummary(sessions: StrengthSession[]) {
  try {
    if (sessions.length === 0) return null;
    const dates = sessions.map((s) => s.date).sort();
    const dateRange = { first: dates[0], last: dates[dates.length - 1] };

    const keyLifts = identifyKeyLifts(sessions, PROGRESSION_CONFIG)
      .map((exercise) => {
        try {
          const p = computeLiftProgression(exercise, sessions, PROGRESSION_CONFIG);
          return {
            exercise,
            currentE1RM: Math.round(p.e1RM.current),
            pr: p.e1RM.pr ? { weight_kg: Math.round(p.e1RM.pr.weight_kg), date: p.e1RM.pr.date } : null,
            trend: p.e1RM.trend_6w
              ? { direction: p.e1RM.trend_6w.direction, percent_change: p.e1RM.trend_6w.percent_change }
              : null,
            lastTrained: p.frequency.last_trained,
          };
        } catch {
          return null; // exercise with no scorable normal sets (e.g. bodyweight/cardio)
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const weeksSpanned = Math.max(1, Math.round((Date.now() - new Date(dateRange.first).getTime()) / (7 * 86400000)));
    const frequencyPerWeek = Math.round((sessions.length / weeksSpanned) * 10) / 10;

    return { dateRange, frequencyPerWeek, keyLifts };
  } catch {
    return null;
  }
}

// Normalize an exercise name for cross-source matching: lowercase and drop the
// equipment parenthetical, so the program's "Bench Press (Barbell)" matches
// Hevy's "Bench Press" (or vice versa).
function normalizeExercise(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

/** The parts of a program document adherence reads. */
export interface AdherenceProgram {
  title?: string;
  sessions?: Array<{ label?: string; exercises?: Array<{ name?: string }> }>;
  profileSnapshot?: { fixed_sessions?: Array<{ activity?: string }> };
}

/**
 * Compare the imported sessions against the athlete's active program (the one
 * the app shows them; the caller loads it) to show plan adherence: which
 * prescribed lifts were hit, missed, or swapped for something else over the
 * current block. Never throws: returns null when there's no program or no
 * planned lifts.
 */
export function buildAdherenceSummary(program: AdherenceProgram | null | undefined, sessions: StrengthSession[]) {
  try {
    if (!program || sessions.length === 0) return null;

    // Classes / fixed sessions (e.g. a weekly Hyrox or CrossFit class) aren't
    // logged in Hevy, so they must not count as "planned" work — otherwise they
    // would always read as missed. Exclude any program session whose label
    // matches one of the athlete's fixed sessions (from the program's own
    // profile snapshot, so it reflects the classes at generation time).
    const fixedActivities = new Set(
      (program.profileSnapshot?.fixed_sessions ?? [])
        .map((f) => normalizeExercise(f.activity || ""))
        .filter(Boolean)
    );

    // Planned exercises come from the program's detailed workout sessions only.
    const plannedDisplay = new Map<string, string>(); // normalized -> display name
    for (const s of program.sessions ?? []) {
      if (s?.label && fixedActivities.has(normalizeExercise(s.label))) continue; // skip class sessions
      for (const ex of s.exercises ?? []) {
        if (ex?.name) plannedDisplay.set(normalizeExercise(ex.name), ex.name);
      }
    }
    if (plannedDisplay.size === 0) return null;

    // Actual = the most recent training block: sessions within 14 days of the
    // latest logged session. Anchoring to the latest session (not "now" or the
    // program's creation date) keeps this populated for a weekly check-in even
    // when the plan was just generated or the export is a little stale.
    const latest = sessions.reduce((m, s) => (s.date > m ? s.date : m), sessions[0].date);
    const since = new Date(new Date(latest).getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const windowSessions = sessions.filter((s) => s.date >= since);

    const actualDisplay = new Map<string, string>();
    for (const s of windowSessions) {
      for (const ex of s.exercises ?? []) {
        if (ex?.name) actualDisplay.set(normalizeExercise(ex.name), ex.name);
      }
    }

    // Word-set matching (lib/trainingLog.ts), so "Barbell Squat" in the plan
    // counts as "Squat (Barbell)" in Hevy.
    const planned = [...plannedDisplay.values()];
    const actual = [...actualDisplay.values()];
    const loggedAsPlanned = (p: string) => actual.some((a) => exercisesMatch(p, a));

    return {
      programTitle: program.title ?? null,
      since,
      sessionsLogged: windowSessions.length,
      hit: planned.filter(loggedAsPlanned),
      missed: planned.filter((p) => !loggedAsPlanned(p)),
      added: actual.filter((a) => !planned.some((p) => exercisesMatch(p, a))),
    };
  } catch {
    return null;
  }
}
