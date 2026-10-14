// Ends a background generation: deletes its "generating" placeholder and
// writes the outcome to the summary — but only while the summary is still
// tracking that placeholder (idField, set by the queueing onCall). Once a
// newer generation has been queued, it owns the summary's status, so an
// older one finishing or being swept (sweepStaleGenerations.ts) mustn't mark
// it done or failed. A summary with no id (meal plans, or a program queued
// before ids were stored) is settled by whichever placeholder ends.
import { DocumentReference, getFirestore } from "firebase-admin/firestore";

export async function settleGeneration(
  placeholder: DocumentReference,
  idField: "programGenerationId" | "mealPlanGenerationId",
  summaryUpdate: Record<string, unknown>
): Promise<void> {
  // Placeholders live at users/{uid}/{collection}/{id}.
  const summaryRef = placeholder.parent.parent!.collection("state").doc("summary");
  await getFirestore().runTransaction(async (tx) => {
    const trackedId = (await tx.get(summaryRef)).get(idField) ?? placeholder.id;
    tx.delete(placeholder);
    if (trackedId === placeholder.id) tx.update(summaryRef, summaryUpdate);
  });
}
