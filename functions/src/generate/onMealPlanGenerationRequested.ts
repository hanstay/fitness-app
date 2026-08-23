// Firestore trigger that does the actual meal-plan generation in the
// background — see onProgramGenerationRequested.ts for the equivalent
// program-side trigger and why this pattern is needed.
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { runGenerateMealPlan } from "./generateMealPlan";

export const onMealPlanGenerationRequested = onDocumentWritten(
  { document: "users/{uid}/mealPlans/{mealPlanId}", secrets: ["ANTHROPIC_API_KEY"], timeoutSeconds: 300 },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists || after.data()?.status !== "generating") return;

    const { uid, mealPlanId } = event.params;
    const db = getFirestore();

    try {
      await runGenerateMealPlan(uid);
      await db.doc(`users/${uid}/mealPlans/${mealPlanId}`).delete();
    } catch (err) {
      const message = err instanceof HttpsError ? err.message : err instanceof Error ? err.message : String(err);
      await db.batch()
        .delete(db.doc(`users/${uid}/mealPlans/${mealPlanId}`))
        .update(db.doc(`users/${uid}/state/summary`), { mealPlanGenerationStatus: "error", mealPlanGenerationError: message })
        .commit();
    }
  }
);
