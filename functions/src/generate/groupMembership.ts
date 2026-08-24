// Toggling which plan is active and leaving a group. Kept separate from
// createGroup.ts since neither needs the ANTHROPIC_API_KEY secret or a long
// timeout.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";

export const setActiveProgramSource = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const source = request.data?.source;
  if (source !== "personal" && source !== "group") {
    throw new HttpsError("invalid-argument", 'source must be "personal" or "group".');
  }

  const db = getFirestore();
  const summaryRef = db.doc(`users/${request.auth.uid}/state/summary`);
  const summarySnap = await summaryRef.get();
  if (source === "group" && !summarySnap.data()?.groupId) {
    throw new HttpsError("failed-precondition", "You're not in a group yet.");
  }

  await summaryRef.update({ activeProgramSource: source });
  return { activeProgramSource: source };
});

export const leaveGroup = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const db = getFirestore();
  const uid = request.auth.uid;
  const summaryRef = db.doc(`users/${uid}/state/summary`);

  const groupId = (await summaryRef.get()).data()?.groupId;
  if (!groupId) throw new HttpsError("failed-precondition", "You're not in a group.");

  const groupRef = db.doc(`groups/${groupId}`);
  await db.runTransaction(async (tx) => {
    const groupSnap = await tx.get(groupRef);
    if (groupSnap.exists) {
      const memberUids: string[] = groupSnap.data()?.memberUids ?? [];
      // No leader-reassignment or leader-removes-member flow exists, so a
      // leader leaving a group that still has other members would orphan it
      // (nobody left who can add members). Require them to be last out.
      if (groupSnap.data()?.leaderUid === uid && memberUids.length > 1) {
        throw new HttpsError("failed-precondition", "You're the group leader — other members need to leave first.");
      }
      const memberEmails: Record<string, string> = { ...(groupSnap.data()?.memberEmails ?? {}) };
      delete memberEmails[uid];
      tx.update(groupRef, { memberUids: memberUids.filter((m) => m !== uid), memberEmails });
    }
    tx.update(summaryRef, { groupId: null, activeProgramSource: "personal" });
  });

  return { left: true };
});
