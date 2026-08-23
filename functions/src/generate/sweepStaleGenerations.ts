// Scheduled cleanup for "generating" placeholders orphaned by a background
// generation trigger that got killed by its own 300s platform timeout before
// it could write an error (see onProgramGenerationRequested.ts /
// onMealPlanGenerationRequested.ts — the try/catch there never runs if the
// platform kills the invocation outright). Without this, such a placeholder
// sits at status:"generating" forever with nothing to surface it.
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { GENERATION_STALE_AFTER_MS } from "../lib/staleGeneration";

const STALE_MESSAGE = "This took longer than expected and appears to have stalled. Please try again.";

interface SweepTarget {
  collectionId: "programs" | "mealPlans";
  statusField: "programGenerationStatus" | "mealPlanGenerationStatus";
  errorField: "programGenerationError" | "mealPlanGenerationError";
  startedAtField: "programGenerationStartedAt" | "mealPlanGenerationStartedAt";
}

const TARGETS: SweepTarget[] = [
  { collectionId: "programs", statusField: "programGenerationStatus", errorField: "programGenerationError", startedAtField: "programGenerationStartedAt" },
  { collectionId: "mealPlans", statusField: "mealPlanGenerationStatus", errorField: "mealPlanGenerationError", startedAtField: "mealPlanGenerationStartedAt" },
];

async function sweep(db: FirebaseFirestore.Firestore, target: SweepTarget): Promise<number> {
  const cutoff = Timestamp.fromMillis(Date.now() - GENERATION_STALE_AFTER_MS);
  const snap = await db
    .collectionGroup(target.collectionId)
    .where("status", "==", "generating")
    .where("createdAt", "<", cutoff)
    .get();

  for (const doc of snap.docs) {
    // Placeholders live at users/{uid}/{collectionId}/{id} — uid is the
    // grandparent of the doc ref.
    const uid = doc.ref.parent.parent?.id;
    if (!uid) continue;
    await db
      .batch()
      .delete(doc.ref)
      .update(db.doc(`users/${uid}/state/summary`), {
        [target.statusField]: "error",
        [target.errorField]: STALE_MESSAGE,
        [target.startedAtField]: FieldValue.delete(),
      })
      .commit();
  }

  return snap.size;
}

export const sweepStaleGenerations = onSchedule("every 5 minutes", async () => {
  const db = getFirestore();
  await Promise.all(TARGETS.map((target) => sweep(db, target)));
});
