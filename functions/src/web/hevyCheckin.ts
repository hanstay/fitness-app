// Browser entry point for the Hevy import on the check-in and onboarding
// pages. Bundled by `npm run build:web` into public/js/generated/hevy-checkin.js,
// which is committed (the site has no build step). CI fails if the bundle is
// out of date, so rebuild it after changing anything this imports.
import { parseHevyCsvToSessions } from "../lib/hevyAnalyzer";
import { parseHevyCsvToCurrentLifts } from "../lib/hevyParser";
import { buildProgressionSummary } from "../lib/hevyCheckinSummary";

// The check-in's "Update my plan" counts a schedule or goal change as new
// information, decided as a personal plan's generation decides it.
export { structuralChanged } from "../lib/programDecisions";

/**
 * Parse a Hevy CSV export entirely in the browser. Returns the sessions and
 * current lifts to send to the saveHevySessions function, plus the progression
 * summary to show right away. Throws with a user-facing message when the file
 * isn't a usable Hevy export.
 */
export function analyzeHevyCsv(csvText: string) {
  const sessions = parseHevyCsvToSessions(csvText);
  if (sessions.length === 0) throw new Error("No sessions found in that CSV — check it's a Hevy export.");
  const lifts = parseHevyCsvToCurrentLifts(csvText);
  if (lifts.length === 0) throw new Error("No working sets found in that CSV — check it's a Hevy export.");
  return { sessions, lifts, progression: buildProgressionSummary(sessions) };
}
