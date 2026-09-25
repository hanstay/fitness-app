// Creates a group: just the caller as its sole member and leader, plus what's
// common to the group (goal, optional target events, the schedule they
// actually train together on). Deliberately does NOT add members or generate
// a program here — those are separate, explicit steps (addGroupMember.ts,
// and the existing generateProgram call once the group is ready) so the flow
// is create -> add teammates -> generate, not one opaque action.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { groupDetailsInputSchema } from "./groupDetailsInput";

export const createGroup = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const parsed = groupDetailsInputSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.issues[0]?.message ?? "Invalid group details.");
  }
  const { name, goal, events, daysPerWeek, fixedSessions } = parsed.data;

  const db = getFirestore();
  const uid = request.auth.uid;

  const summaryRef = db.doc(`users/${uid}/state/summary`);
  const summarySnap = await summaryRef.get();
  if (summarySnap.data()?.groupId) {
    throw new HttpsError("failed-precondition", "You're already in a group — leave it first.");
  }

  const groupRef = db.collection("groups").doc();
  const batch = db.batch();
  batch.set(groupRef, {
    name: name || null,
    goal,
    events: events ?? [],
    daysPerWeek,
    fixedSessions: fixedSessions ?? [],
    leaderUid: uid,
    memberUids: [uid],
    memberEmails: { [uid]: request.auth.token.email ?? "" },
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.update(summaryRef, { groupId: groupRef.id, activeProgramSource: "group" });
  await batch.commit();

  return { groupId: groupRef.id };
});
