import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { syncIntervalsActivitiesForUser } from "../lib/intervalsClient";

/** Manual "Sync Now" — re-pulls activities/wellness using the already-stored credential. */
export const syncIntervalsActivities = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const db = getFirestore();
  const credsDoc = await db.doc(`credentials/${uid}`).get();
  const creds = credsDoc.data()?.intervalsIcu;
  if (!creds?.athleteId || !creds?.apiKey) {
    throw new HttpsError("failed-precondition", "Connect intervals.icu first.");
  }

  try {
    return await syncIntervalsActivitiesForUser(uid, creds.athleteId, creds.apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.intervalsIcu.lastError": message,
    }).catch(() => {});
    throw new HttpsError("internal", `Sync failed: ${message}`);
  }
});
