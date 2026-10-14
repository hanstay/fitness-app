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

// A group plan is the shared program plus this member's own layer, and a
// weekly update only rewrites the layer — so its id covers both. The layer's
// change summary only describes the shared program it was written against;
// once another member's run replaces that program, it's out of date.
export function groupPlan(sharedProgramId, member) {
  return {
    planId: `${sharedProgramId}@${member?.updatedAt?.toMillis?.() ?? ""}`,
    changeSummary: member?.groupProgramId === sharedProgramId ? member.changeSummary : null,
  };
}

// Per device, by plan id: the personal program doc id, or groupPlan's id.
// localStorage can throw (private mode, blocked storage); losing these only
// means a notice shows again, or not at all.
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* see above */ }
}

// The dashboard's "Your plan is updated" notice, until the plan is opened.
// With nothing recorded yet (the first visit since this shipped, or cleared
// storage) the current plan counts as seen, rather than announcing an update
// that may be weeks old.
export function isUnseenUpdate(planId) {
  const seenId = read("planSeenId");
  if (seenId === null) markPlanSeen(planId);
  return seenId !== null && seenId !== planId;
}
export const markPlanSeen = (planId) => write("planSeenId", planId);

// The program page's "What changed" box, until it's closed.
export const changesDismissed = (planId) => read("changesDismissedId") === planId;
export const dismissChanges = (planId) => write("changesDismissedId", planId);
