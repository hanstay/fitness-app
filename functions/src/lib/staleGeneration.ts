// Pure helper for detecting an orphaned "generating" placeholder — one whose
// background function was killed by its own 300s platform timeout before it
// could write an error (see onProgramGenerationRequested.ts /
// onMealPlanGenerationRequested.ts). No Firebase imports, so it's usable from
// both the server-side sweep and, duplicated by hand in dashboard.html (a
// plain script with no build step to share this file across the client/
// server boundary), the client-side "still working?" check.

// Comfortably above the 300s function timeout so we never flag a job that's
// still legitimately running.
export const GENERATION_STALE_AFTER_MS = 6 * 60 * 1000;

export function isStaleGeneration(createdAt: Date | null, nowMs: number, staleAfterMs = GENERATION_STALE_AFTER_MS): boolean {
  if (!createdAt) return false; // serverTimestamp hasn't resolved yet — too new to judge
  return nowMs - createdAt.getTime() > staleAfterMs;
}
