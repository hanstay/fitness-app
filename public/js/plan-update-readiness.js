// Whether the check-in's "Update my plan" has anything new to work from.
// An update shouldn't act on data a plan already used, so the button waits
// for one of:
// - a Hevy import or intervals.icu sync that brought in workouts or
//   activities not stored before (their lastNewDataAt, written by the
//   server) after the plan read its data. Re-importing the same export, or a
//   sync that finds nothing new, doesn't count.
// - a goal, schedule, equipment or event change since the plan, decided as
//   a personal plan's generation decides it (structuralChanged).
// - a group plan whose shared program was replaced (by another member's
//   update) after this member's layer was written for it.
// - starting the next phase early, or there being no plan yet.

const millis = (ts) => (ts?.toMillis ? ts.toMillis() : null);

/**
 * summary: users/{uid}/state/summary data. plan: the current plan from
 * loadCurrentProgram, or null if there's none. profileChanged: the athlete's
 * profile differs structurally from plan.profileSnapshot.
 * hevyImporting / icuSyncing: an import or sync this page started is in
 * flight; the update waits for it, so it runs on the newest data.
 * Returns { ready, hint }: hint says what's missing when it isn't ready.
 */
export function planUpdateReadiness({ summary, plan, profileChanged, hevyImporting, icuSyncing, startNextPhase }) {
  if (hevyImporting) return { ready: false, hint: "Importing your Hevy workouts…" };
  const hevy = summary?.integrationsStatus?.hevy;
  const icu = summary?.integrationsStatus?.intervalsIcu;
  if (icu?.connected && icuSyncing) return { ready: false, hint: "Syncing intervals.icu…" };
  if (!plan || startNextPhase || profileChanged || plan.layerOutdated) return { ready: true, hint: "" };

  // Older plans have no inputsReadAt; when they were saved is the nearest.
  const readAt = millis(plan.inputsReadAt) ?? millis(plan.updatedAt);
  const isNew = (ts) => millis(ts) !== null && (readAt === null || millis(ts) > readAt);
  // A status written before new data was tracked (no newSessions/newActivities
  // count) can't tell new from re-imported, so its import or sync time
  // stands in until the next one replaces it.
  const hevyNewAt = hevy?.newSessions === undefined ? hevy?.parsedAt : hevy.lastNewDataAt;
  const icuNewAt = icu?.newActivities === undefined ? icu?.lastSyncedAt : icu.lastNewDataAt;
  if (isNew(hevyNewAt) || (icu?.connected && isNew(icuNewAt))) return { ready: true, hint: "" };
  return {
    ready: false,
    hint: icu?.connected
      ? "No new workouts or activities since your plan was last updated. Upload a newer Hevy export or sync intervals.icu after your next session."
      : "No new workouts since your plan was last updated. Upload a newer Hevy export, or connect intervals.icu.",
  };
}
