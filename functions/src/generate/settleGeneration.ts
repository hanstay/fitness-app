// Ends a background generation: deletes its "generating" placeholder and
// writes the outcome to the summary — but only while the summary is still
// tracking that placeholder (idField, set by the queueing onCall). Once a
// newer generation has been queued, it owns the summary's status, so an
// older one finishing or being swept (sweepStaleGenerations.ts) mustn't mark
// it done or failed. A summary with no id (meal plans, or a program queued
// before ids were stored) is settled by whichever placeholder ends.
import { DocumentReference, DocumentSnapshot, FieldValue, Transaction, getFirestore } from "firebase-admin/firestore";
import { isStaleGeneration } from "../lib/staleGeneration";

type IdField = "programGenerationId" | "mealPlanGenerationId";

const tracks = (summary: DocumentSnapshot, idField: IdField, placeholder: DocumentReference) =>
  (summary.get(idField) ?? placeholder.id) === placeholder.id;

// Placeholders live at users/{uid}/{collection}/{id}.
const summaryRefOf = (placeholder: DocumentReference) =>
  placeholder.parent.parent!.collection("state").doc("summary");

export async function settleGeneration(
  placeholder: DocumentReference,
  idField: IdField,
  summaryUpdate: Record<string, unknown>
): Promise<void> {
  const summaryRef = summaryRefOf(placeholder);
  await getFirestore().runTransaction(async (tx) => {
    const [summary, current] = await tx.getAll(summaryRef, placeholder);
    if (!current.exists) return; // already ended (see commitProgramGeneration)
    tx.delete(placeholder);
    if (tracks(summary, idField, placeholder)) tx.update(summaryRef, summaryUpdate);
  });
}

/**
 * Commits a program generation's result in one transaction with the end of
 * the generation, so a run can't be left half-recorded. `write` does its
 * reads, then its writes, and returns any summary fields to set alongside, so
 * the summary is written once.
 *
 * A queued run (`placeholder`, from onProgramGenerationRequested.ts) settles
 * as above, and writes nothing if its placeholder is already gone: a
 * duplicate trigger delivery got there first, or a direct run ended it. A
 * direct run (the generateProgram onCall) clears whatever status is left over
 * unless a queued generation is still in flight; ending a stalled one, it
 * deletes that one's placeholder too, so the sweep can't then fail it.
 */
export async function commitProgramGeneration(
  uid: string,
  placeholder: DocumentReference | undefined,
  write: (tx: Transaction) => Promise<Record<string, unknown>>
): Promise<void> {
  const db = getFirestore();
  const summaryRef = db.doc(`users/${uid}/state/summary`);
  await db.runTransaction(async (tx) => {
    const summary = await tx.get(summaryRef);
    if (placeholder && !(await tx.get(placeholder)).exists) return;
    const trackedId = summary.get("programGenerationId");
    const ends = placeholder
      ? tracks(summary, "programGenerationId", placeholder)
      : summary.get("programGenerationStatus") !== "generating" ||
        isStaleGeneration(summary.get("programGenerationStartedAt")?.toDate() ?? null, Date.now());
    const summaryUpdate = {
      ...(await write(tx)),
      ...(ends ? { programGenerationStatus: FieldValue.delete(), programGenerationStartedAt: FieldValue.delete() } : {}),
    };
    if (placeholder) tx.delete(placeholder);
    else if (ends && trackedId) tx.delete(db.doc(`users/${uid}/programs/${trackedId}`));
    if (Object.keys(summaryUpdate).length) tx.update(summaryRef, summaryUpdate);
  });
}
