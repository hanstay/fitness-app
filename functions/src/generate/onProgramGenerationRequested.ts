// Firestore trigger that does the actual (multi-minute) program generation in
// the background, decoupled from any client connection — this is what makes
// queueProgramGeneration's "return immediately" safe: the client can
// navigate away without risking the generation being silently aborted, since
// nothing here depends on the browser tab that queued it.
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { runGenerateProgram } from "./generateProgram";

export const onProgramGenerationRequested = onDocumentWritten(
  { document: "users/{uid}/programs/{programId}", secrets: ["ANTHROPIC_API_KEY"], timeoutSeconds: 300 },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists || after.data()?.status !== "generating") return;

    const { uid, programId } = event.params;
    const db = getFirestore();

    try {
      await runGenerateProgram(uid);
      // runGenerateProgram archives every prior "active" program and writes a
      // fresh doc of its own; the "generating" placeholder never became
      // active, so it'd be left dangling — delete it explicitly.
      await db.doc(`users/${uid}/programs/${programId}`).delete();
    } catch (err) {
      const message = err instanceof HttpsError ? err.message : err instanceof Error ? err.message : String(err);
      await db.batch()
        .delete(db.doc(`users/${uid}/programs/${programId}`))
        .update(db.doc(`users/${uid}/state/summary`), { programGenerationStatus: "error", programGenerationError: message })
        .commit();
    }
  }
);
