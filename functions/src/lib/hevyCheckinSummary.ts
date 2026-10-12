// The summary the check-in screen shows after a Hevy import: key lifts with
// their e1RM and trend. Pure, no Firebase dependency: the browser computes it
// straight from the parsed CSV (see src/web/hevyCheckin.ts), so the athlete
// sees it without waiting on a save. Generation doesn't use these numbers. It
// reads the raw log and compares it with the previous plan itself (see
// lib/trainingLog.ts), so plan adherence isn't shown to the athlete here.
import { identifyKeyLifts, computeLiftProgression, PROGRESSION_CONFIG, StrengthSession } from "./hevyDerivedData";

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
