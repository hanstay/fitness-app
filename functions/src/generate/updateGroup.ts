// Leader-only: edits a group's goal/name/target events/schedule after
// creation. Membership (memberUids/leaderUid) is untouched here — that's
// addGroupMember.ts/groupMembership.ts's job. The next generation (any
// member's check-in or manual regen) picks up the change automatically via
// needsGroupFullRegen's groupSnapshot comparison — no explicit "regenerate
// now" side effect here, consistent with how a personal profile edit only
// takes effect on that member's own next regen.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { groupDetailsInputSchema } from "./groupDetailsInput";

export const updateGroup = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const parsed = groupDetailsInputSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.issues[0]?.message ?? "Invalid group details.");
  }
  const { name, goal, events, daysPerWeek, fixedSessions } = parsed.data;

  const db = getFirestore();
  const uid = request.auth.uid;

  const summarySnap = await db.doc(`users/${uid}/state/summary`).get();
  const groupId = summarySnap.data()?.groupId;
  if (!groupId) throw new HttpsError("failed-precondition", "You're not in a group.");

  const groupRef = db.doc(`groups/${groupId}`);
  const groupSnap = await groupRef.get();
  if (!groupSnap.exists) throw new HttpsError("not-found", "Group not found.");
  if (groupSnap.data()?.leaderUid !== uid) {
    throw new HttpsError("permission-denied", "Only the group leader can edit group details.");
  }

  await groupRef.update({
    name: name || null,
    goal,
    events: events ?? [],
    daysPerWeek,
    fixedSessions: fixedSessions ?? [],
  });

  return { updated: true };
});
