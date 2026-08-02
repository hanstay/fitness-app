import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { parseHevyCsvToCurrentLifts } from "../lib/hevyParser";

interface Input {
  storagePath: string;
}

export const parseHevyCsv = onCall<Input>(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { storagePath } = request.data;

  const expectedPrefix = `users/${uid}/hevy/`;
  if (!storagePath || !storagePath.startsWith(expectedPrefix)) {
    throw new HttpsError("invalid-argument", "storagePath must be the caller's own upload.");
  }

  const db = getFirestore();
  const bucket = getStorage().bucket();

  try {
    const [buffer] = await bucket.file(storagePath).download();
    const lifts = parseHevyCsvToCurrentLifts(buffer.toString("utf8"));

    if (lifts.length === 0) {
      throw new HttpsError("invalid-argument", "No working sets found in that CSV — check it's a Hevy export.");
    }

    await db.doc(`users/${uid}`).update({ "athlete.current_lifts": lifts });
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.hevy": {
        csvUploaded: true,
        storagePath,
        parsedAt: FieldValue.serverTimestamp(),
        liftsImported: lifts.length,
        lastError: null,
      },
    });

    return { liftsImported: lifts.length, lifts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.hevy.lastError": message,
    }).catch(() => {});
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("internal", `Couldn't parse that CSV: ${message}`);
  }
});
