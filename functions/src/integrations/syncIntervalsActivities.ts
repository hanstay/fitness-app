import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { syncIntervalsActivitiesForUser } from "../lib/intervalsClient";

/** Manual "Sync Now" — re-pulls activities/wellness using the already-stored OAuth token. */
export const syncIntervalsActivities = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const db = getFirestore();
  const credsDoc = await db.doc(`credentials/${uid}`).get();
  const creds = credsDoc.data()?.intervalsIcu;
  if (!creds?.accessToken) {
    throw new HttpsError("failed-precondition", "Connect intervals.icu first.");
  }

  try {
    return await syncIntervalsActivitiesForUser(uid, creds.accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // No refresh token exists for intervals.icu OAuth — a 401/403 means the
    // token has gone stale and the user must reconnect, not just retry.
    const isAuthError = message.includes("(401)") || message.includes("(403)");
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.intervalsIcu.lastError": message,
      ...(isAuthError ? { "integrationsStatus.intervalsIcu.connected": false } : {}),
    }).catch(() => {});
    throw new HttpsError("internal", `Sync failed: ${message}`);
  }
});
