import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { verifyIntervalsCredentials, syncIntervalsActivitiesForUser } from "../lib/intervalsClient";

interface Input {
  athleteId: string;
  apiKey: string;
}

export const saveIntervalsIcuCredentials = onCall<Input>(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { athleteId, apiKey } = request.data;
  if (!athleteId || !apiKey) throw new HttpsError("invalid-argument", "athleteId and apiKey are required.");

  const db = getFirestore();

  try {
    await verifyIntervalsCredentials(athleteId, apiKey);
  } catch (err) {
    throw new HttpsError("invalid-argument", err instanceof Error ? err.message : "Verification failed.");
  }

  // Credential is valid — store it (Admin SDK only path; never readable by the client)
  // and record connection status before attempting the first sync.
  await db.doc(`credentials/${uid}`).set({
    intervalsIcu: { athleteId, apiKey, verifiedAt: FieldValue.serverTimestamp(), lastVerifyError: null },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.doc(`users/${uid}/state/summary`).update({
    "integrationsStatus.intervalsIcu.connected": true,
    "integrationsStatus.intervalsIcu.athleteId": athleteId,
    "integrationsStatus.intervalsIcu.verifiedAt": FieldValue.serverTimestamp(),
    "integrationsStatus.intervalsIcu.lastError": null,
  });

  // Auto-sync immediately on connect, per plan — the initial data pull is
  // part of "connecting," not a separate step the user has to trigger.
  try {
    const { activitiesSynced, wellness } = await syncIntervalsActivitiesForUser(uid, athleteId, apiKey);
    return { connected: true, activitiesSynced, wellness };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.intervalsIcu.lastError": message,
    }).catch(() => {});
    // Credential is valid and saved even if the first sync failed — the user
    // can retry sync later without reconnecting.
    return { connected: true, activitiesSynced: 0, wellness: null, syncError: message };
  }
});
