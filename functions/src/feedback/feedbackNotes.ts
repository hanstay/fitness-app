// The check-in's "Something not right?" notes (see lib/planFeedback.ts): save
// one for the next plan update, take back one that hasn't been used yet, and
// answer the follow-up on an ongoing one. Notes live at
// users/{uid}/feedbackNotes/{id}, readable by their owner and written only
// here and by the plan update (generateProgram.ts).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  normalizeNoteInput, MAX_PENDING_NOTES, MAX_ACTIVE_NOTES, FOLLOW_UP_OUTCOMES, FollowUpOutcome, followUpChange,
} from "../lib/planFeedback";

// Group plans are written for the whole group, and a note can't change one
// member's copy of it yet, so notes are for personal plans only.
async function requirePersonalPlan(uid: string): Promise<void> {
  const summary = (await getFirestore().doc(`users/${uid}/state/summary`).get()).data() ?? {};
  if (summary.activeProgramSource === "group" && summary.groupId) {
    throw new HttpsError("failed-precondition", "Notes aren't available on group plans yet.");
  }
}

export const addFeedbackNote = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const normalized = normalizeNoteInput(request.data);
  if ("error" in normalized) throw new HttpsError("invalid-argument", normalized.error);
  await requirePersonalPlan(uid);

  const db = getFirestore();
  const notes = db.collection(`users/${uid}/feedbackNotes`);
  const [pending, active] = await Promise.all([
    notes.where("status", "==", "pending").count().get(),
    notes.where("status", "in", ["pending", "open"]).count().get(),
  ]);
  if (pending.data().count >= MAX_PENDING_NOTES) {
    throw new HttpsError("resource-exhausted", `You already have ${MAX_PENDING_NOTES} notes waiting. Update your plan first, then add more.`);
  }
  if (active.data().count >= MAX_ACTIVE_NOTES) {
    throw new HttpsError("resource-exhausted", `Your plan is already working around ${MAX_ACTIVE_NOTES} notes. Mark some as better at check-in, then add more.`);
  }
  const ref = await notes.add({
    ...normalized.note,
    status: "pending",
    source: "checkin",
    worse: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { noteId: ref.id };
});

const noteRef = (uid: string, noteId: unknown) => {
  if (typeof noteId !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(noteId)) {
    throw new HttpsError("invalid-argument", "Unknown note.");
  }
  return getFirestore().doc(`users/${uid}/feedbackNotes/${noteId}`);
};

/** Takes back a note the next update hasn't used yet. */
export const removeFeedbackNote = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const ref = noteRef(request.auth.uid, request.data?.noteId);
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return; // already gone
    if (snap.get("status") !== "pending") {
      throw new HttpsError("failed-precondition", "That note has already been used in a plan update.");
    }
    tx.delete(ref);
  });
  return { ok: true };
});

/** The check-in follow-up on an ongoing note: still a problem, better, or worse. */
export const followUpFeedbackNote = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const outcome = request.data?.outcome as FollowUpOutcome;
  if (!FOLLOW_UP_OUTCOMES.includes(outcome)) throw new HttpsError("invalid-argument", "Unknown answer.");
  const ref = noteRef(request.auth.uid, request.data?.noteId);
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("status") !== "open") {
      throw new HttpsError("failed-precondition", "That note isn't waiting for a follow-up.");
    }
    tx.update(ref, { ...followUpChange(outcome), lastFollowUp: outcome, followedUpAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});
