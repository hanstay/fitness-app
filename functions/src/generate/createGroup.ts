// Creates a group and generates its first shared program. Whether or not any
// member already has an individual plan is irrelevant — the group's program
// is always freshly generated from every current member's own profile,
// exactly like any later regeneration (see runGenerateProgram's
// activeProgramSource branch / groupProgram.ts), so there's no separate
// "blend existing plans" path.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { runGenerateProgram } from "./generateProgram";

export const createGroup = onCall({ secrets: ["ANTHROPIC_API_KEY"], timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const memberEmails: unknown = request.data?.memberEmails;
  if (!Array.isArray(memberEmails) || memberEmails.length === 0 || !memberEmails.every((e) => typeof e === "string")) {
    throw new HttpsError("invalid-argument", "Provide at least one teammate email.");
  }

  const db = getFirestore();
  const auth = getAuth();

  const resolvedMembers = await Promise.all(
    (memberEmails as string[]).map(async (email) => {
      try {
        const user = await auth.getUserByEmail(email);
        return { uid: user.uid, email: user.email ?? email };
      } catch {
        throw new HttpsError("not-found", `No account found for ${email}.`);
      }
    })
  );

  // memberEmails so the group doc can show each member's email without any
  // client needing to read another user's users/{uid} doc (rules restrict
  // that to the owner only).
  const memberEmailsByUid: Record<string, string> = { [request.auth.uid]: request.auth.token.email ?? "" };
  for (const m of resolvedMembers) memberEmailsByUid[m.uid] = m.email;

  const memberUids = Object.keys(memberEmailsByUid);
  if (memberUids.length < 2) {
    throw new HttpsError("invalid-argument", "A group needs at least one other member.");
  }

  // Refuse if anyone (including the caller) is already in a group — v1 has
  // no leave-and-rejoin-atomically flow, so avoid leaving a stale uid behind
  // in another group's memberUids array.
  const summarySnaps = await Promise.all(memberUids.map((uid) => db.doc(`users/${uid}/state/summary`).get()));
  const alreadyGrouped = summarySnaps.filter((s) => s.data()?.groupId);
  if (alreadyGrouped.length > 0) {
    throw new HttpsError("failed-precondition", "One or more members are already in a group — leave it first.");
  }

  const groupRef = db.collection("groups").doc();
  const batch = db.batch();
  batch.set(groupRef, { memberUids, memberEmails: memberEmailsByUid, createdAt: FieldValue.serverTimestamp() });
  for (const uid of memberUids) {
    batch.update(db.doc(`users/${uid}/state/summary`), { groupId: groupRef.id, activeProgramSource: "group" });
  }
  await batch.commit();

  try {
    const program = await runGenerateProgram(request.auth.uid);
    return { groupId: groupRef.id, program };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpsError("internal", `Group created, but couldn't generate the first program: ${message}`);
  }
});
