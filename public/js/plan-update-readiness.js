// Whether the check-in's "Update my plan" has anything new to work from.
// An update shouldn't act on data a plan already used, so the button waits
// until a Hevy import or intervals.icu sync has brought in workouts or
// activities not stored before (their lastNewDataAt, written by the server)
// since the plan was last updated. Re-importing the same export, or a sync
// that finds nothing new, doesn't count. Starting the next phase early needs
// no new data.

const millis = (ts) => (ts?.toMillis ? ts.toMillis() : null);

// True if `ts` is after the plan's last update, or there's no plan yet.
function isNewSincePlan(ts, planUpdatedAt) {
  const at = millis(ts);
  if (at === null) return false;
  const planAt = millis(planUpdatedAt);
  return planAt === null || at > planAt;
}

/**
 * summary: users/{uid}/state/summary data. planUpdatedAt: the current plan's
 * `updatedAt` Timestamp from loadCurrentProgram, or null if there's no plan.
 * hevyImporting / icuSyncing: an import or sync this page started is in
 * flight; the update waits for it, so it runs on the newest data.
 * Returns { ready, hint }: hint says what's missing when it isn't ready.
 */
export function planUpdateReadiness({ summary, planUpdatedAt, hevyImporting, icuSyncing, startNextPhase }) {
  if (hevyImporting) return { ready: false, hint: "Importing your Hevy workouts…" };
  const hevy = summary?.integrationsStatus?.hevy;
  const icu = summary?.integrationsStatus?.intervalsIcu;
  if (icu?.connected && icuSyncing) return { ready: false, hint: "Syncing intervals.icu…" };
  const newHevy = isNewSincePlan(hevy?.lastNewDataAt, planUpdatedAt);
  const newIcu = Boolean(icu?.connected) && isNewSincePlan(icu?.lastNewDataAt, planUpdatedAt);
  if (newHevy || newIcu || startNextPhase) return { ready: true, hint: "" };
  return {
    ready: false,
    hint: icu?.connected
      ? "No new workouts or activities since your plan was last updated. Upload a newer Hevy export or sync intervals.icu after your next session."
      : "No new workouts since your plan was last updated. Upload a newer Hevy export, or connect intervals.icu.",
  };
}
