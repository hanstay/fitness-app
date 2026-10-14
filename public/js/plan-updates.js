// Shared by the dashboard, check-in and program pages for plans generated in
// the background: when an in-flight generation counts as stalled, and which
// updated plan this device has already looked at.

// Kept in sync by hand with functions/src/lib/staleGeneration.ts — comfortably
// above the background function's own 300s timeout, and the server-side
// sweep (sweepStaleGenerations.ts) uses the same threshold to eventually
// mark these "error" even if nobody has a page open to see this.
export const GENERATION_STALE_AFTER_MS = 6 * 60 * 1000;

// startedAt: the summary's programGenerationStartedAt/mealPlanGenerationStartedAt.
export function isStale(startedAt) {
  const ms = startedAt?.toDate ? startedAt.toDate().getTime() : null;
  if (!ms) return false;
  return Date.now() - ms > GENERATION_STALE_AFTER_MS;
}

// Per device, by plan id: the personal program doc id, or the group program
// doc id for a group plan (see program.html). localStorage can throw (private
// mode, blocked storage); losing these only means a notice shows again.
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* see above */ }
}

// The dashboard's "Your plan is updated" notice, until the plan is opened.
export const planSeen = (planId) => read("planSeenId") === planId;
export const markPlanSeen = (planId) => write("planSeenId", planId);

// The program page's "What changed" box, until it's closed.
export const changesDismissed = (planId) => read("changesDismissedId") === planId;
export const dismissChanges = (planId) => write("changesDismissedId", planId);
