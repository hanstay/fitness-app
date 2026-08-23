import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { syncIntervalsActivitiesForUser } from "../lib/intervalsClient";

interface Input {
  code: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  athlete: { id: string; name?: string };
}

export const connectIntervalsIcuOAuth = onCall<Input>(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { code } = request.data;
  if (!code) throw new HttpsError("invalid-argument", "code is required.");

  const clientId = process.env.INTERVALS_ICU_CLIENT_ID;
  const clientSecret = process.env.INTERVALS_ICU_CLIENT_SECRET;
  const redirectUri = process.env.INTERVALS_ICU_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new HttpsError("failed-precondition", "intervals.icu OAuth is not configured on the server.");
  }

  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
  const tokenRes = await fetch("https://intervals.icu/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new HttpsError("invalid-argument", `intervals.icu rejected the authorization (${tokenRes.status}): ${text || "no details"}`);
  }
  const token = (await tokenRes.json()) as TokenResponse;

  const db = getFirestore();

  // Credential is valid — store it (Admin SDK only path; never readable by the client)
  // and record connection status before attempting the first sync.
  await db.doc(`credentials/${uid}`).set({
    intervalsIcu: {
      accessToken: token.access_token,
      athleteId: token.athlete?.id ?? null,
      connectedVia: "oauth",
      scope: token.scope ?? null,
      verifiedAt: FieldValue.serverTimestamp(),
      lastVerifyError: null,
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.doc(`users/${uid}/state/summary`).update({
    "integrationsStatus.intervalsIcu.connected": true,
    "integrationsStatus.intervalsIcu.athleteId": token.athlete?.id ?? null,
    "integrationsStatus.intervalsIcu.verifiedAt": FieldValue.serverTimestamp(),
    "integrationsStatus.intervalsIcu.lastError": null,
  });

  // Auto-sync immediately on connect — the initial data pull is part of
  // "connecting," not a separate step the user has to trigger.
  try {
    const { activitiesSynced, wellness } = await syncIntervalsActivitiesForUser(uid, token.access_token);
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
