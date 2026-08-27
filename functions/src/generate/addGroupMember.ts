// Leader-only: adds an existing account to the leader's own group by email.
// No invite/pending-signup flow — if the email has no account yet, this just
// fails with a clear message telling the leader to have them sign up first.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

export const addGroupMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const email = typeof request.data?.email === "string" ? request.data.email.trim() : "";
  if (!email) throw new HttpsError("invalid-argument", "Provide a teammate email.");

  const db = getFirestore();
  const auth = getAuth();
  const uid = request.auth.uid;

  const summarySnap = await db.doc(`users/${uid}/state/summary`).get();
  const groupId = summarySnap.data()?.groupId;
  if (!groupId) throw new HttpsError("failed-precondition", "You're not in a group.");

  const groupRef = db.doc(`groups/${groupId}`);
  const groupSnap = await groupRef.get();
  if (!groupSnap.exists) throw new HttpsError("not-found", "Group not found.");
  if (groupSnap.data()?.leaderUid !== uid) {
    throw new HttpsError("permission-denied", "Only the group leader can add members.");
  }

  let targetUid: string;
  let targetEmail: string;
  try {
    const user = await auth.getUserByEmail(email);
    targetUid = user.uid;
    targetEmail = user.email ?? email;
  } catch {
    throw new HttpsError("not-found", `No account found for ${email} — ask them to sign up first, then add them.`);
  }

  const targetSummaryRef = db.doc(`users/${targetUid}/state/summary`);
  const targetSummarySnap = await targetSummaryRef.get();
  if (targetSummarySnap.data()?.groupId) {
    throw new HttpsError("failed-precondition", `${targetEmail} is already in a group.`);
  }

  const batch = db.batch();
  batch.update(groupRef, {
    memberUids: FieldValue.arrayUnion(targetUid),
    [`memberEmails.${targetUid}`]: targetEmail,
  });
  batch.update(targetSummaryRef, { groupId, activeProgramSource: "group" });
  await batch.commit();

  return { added: targetEmail };
});
