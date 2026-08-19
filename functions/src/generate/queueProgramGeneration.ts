// Thin, fast onCall that just queues a program generation — used by
// onboarding so the client can navigate to the dashboard immediately instead
// of holding an in-flight connection open for the multi-minute LLM call (see
// onProgramGenerationRequested.ts, which does the actual work in the
// background once this placeholder lands).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const queueProgramGeneration = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  const athlete = userSnap.data()?.athlete;

  if (!athlete?.training_days_per_week || !athlete?.session_length_minutes) {
    throw new HttpsError("failed-precondition", "Complete your training profile first (days/week, session length).");
  }

  const placeholderRef = db.collection(`users/${uid}/programs`).doc();
  await db.batch()
    .set(placeholderRef, { status: "generating", createdAt: FieldValue.serverTimestamp() })
    .update(db.doc(`users/${uid}/state/summary`), {
      programGenerationStatus: "generating",
      programGenerationError: FieldValue.delete(),
      // Lets the client judge staleness (see lib/staleGeneration.ts) without a
      // second listener on the placeholder doc itself.
      programGenerationStartedAt: FieldValue.serverTimestamp(),
    })
    .commit();

  return { programId: placeholderRef.id };
});
