// Firestore trigger that does the actual (multi-minute) program generation in
// the background, decoupled from any client connection — this is what makes
// queueProgramGeneration's "return immediately" safe: the client can
// navigate away without risking the generation being silently aborted, since
// nothing here depends on the browser tab that queued it.
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { runGenerateProgram } from "./generateProgram";
import { settleGeneration } from "./settleGeneration";
import { toProgramGenerationRequest } from "../lib/programGenerationRequest";

export const onProgramGenerationRequested = onDocumentWritten(
  {
    document: "users/{uid}/programs/{programId}",
    secrets: ["ANTHROPIC_API_KEY"],
    timeoutSeconds: 300,
    // Bounds how many of these run at once, which bounds concurrent pressure
    // on the Anthropic API when a burst of users onboard together. Eventarc
    // queues excess writes and delivers them as instances free up — this is
    // a real (if coarse) throttle, not just a resource cap. Tune against your
    // Anthropic tier's actual RPM/TPM limits.
    maxInstances: 5,
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists || after.data()?.status !== "generating") return;

    try {
      await runGenerateProgram(event.params.uid, toProgramGenerationRequest(after.data()?.request));
    } catch (err) {
      const message = err instanceof HttpsError ? err.message : err instanceof Error ? err.message : String(err);
      await settleGeneration(after.ref, "programGenerationId", {
        programGenerationStatus: "error",
        programGenerationError: message,
        programGenerationStartedAt: FieldValue.delete(),
      });
      return;
    }
    // runGenerateProgram archives every prior "active" program and writes a
    // fresh doc of its own; the "generating" placeholder never became active,
    // so it'd be left dangling — delete it, and clear the status (which
    // runGenerateProgram leaves alone: see settleGeneration.ts).
    await settleGeneration(after.ref, "programGenerationId", {
      programGenerationStatus: FieldValue.delete(),
      programGenerationStartedAt: FieldValue.delete(),
    });
  }
);
