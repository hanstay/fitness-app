// Thin, fast onCall that just queues a program generation — used by
// onboarding, the dashboard and the check-in so the client can move on
// immediately instead of holding an in-flight connection open for the
// multi-minute LLM call (see onProgramGenerationRequested.ts, which does the
// actual work in the background once this placeholder lands).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { toProgramGenerationRequest } from "../lib/programGenerationRequest";
import { recordFollowUps } from "../feedback/feedbackNotes";

export const queueProgramGeneration = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  const athlete = userSnap.data()?.athlete;
  const { groupId, activeProgramSource } = (await db.doc(`users/${uid}/state/summary`).get()).data() ?? {};

  // Same precondition, and the same group exemption, as runGenerateProgram —
  // checked here too so it fails fast instead of in the background.
  const followsGroup = activeProgramSource === "group" && groupId;
  if (!followsGroup && (!athlete?.training_days_per_week || !athlete?.session_length_minutes)) {
    throw new HttpsError("failed-precondition", "Complete your training profile first (days/week, session length).");
  }

  // The check-in's follow-up answers on ongoing notes go with the request, so
  // they're recorded before the update reads the notes.
  await recordFollowUps(uid, request.data?.followUps);

  const placeholderRef = db.collection(`users/${uid}/programs`).doc();
  await db.batch()
    .set(placeholderRef, {
      status: "generating",
      createdAt: FieldValue.serverTimestamp(),
      request: toProgramGenerationRequest(request.data),
    })
    .update(db.doc(`users/${uid}/state/summary`), {
      programGenerationStatus: "generating",
      programGenerationError: FieldValue.delete(),
      // Lets the client judge staleness (see lib/staleGeneration.ts) without a
      // second listener on the placeholder doc itself.
      programGenerationStartedAt: FieldValue.serverTimestamp(),
      // The generation the status now belongs to (see settleGeneration.ts).
      programGenerationId: placeholderRef.id,
    })
    .commit();

  return { programId: placeholderRef.id };
});
