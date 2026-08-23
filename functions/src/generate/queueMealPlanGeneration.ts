// Thin, fast onCall that just queues a meal-plan generation — see
// queueProgramGeneration.ts for why this exists (lets onboarding navigate
// away without risking the generation being aborted mid-flight).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const queueMealPlanGeneration = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  const nutrition = userSnap.data()?.nutrition;
  const currentTargets = (await db.doc(`users/${uid}/state/summary`).get()).data()?.currentTargets;

  if (!currentTargets) {
    throw new HttpsError("failed-precondition", "Calculate your targets first.");
  }
  if (!nutrition?.meals_per_day) {
    throw new HttpsError("failed-precondition", "Complete your nutrition profile first (meals/day).");
  }

  const placeholderRef = db.collection(`users/${uid}/mealPlans`).doc();
  await db.batch()
    .set(placeholderRef, { status: "generating", createdAt: FieldValue.serverTimestamp() })
    .update(db.doc(`users/${uid}/state/summary`), { mealPlanGenerationStatus: "generating", mealPlanGenerationError: FieldValue.delete() })
    .commit();

  return { mealPlanId: placeholderRef.id };
});
