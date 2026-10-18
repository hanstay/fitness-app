// The check-in's "Something not right?" notes (see lib/planFeedback.ts): save
// one for the next plan update, take back one that hasn't been used yet, and
// answer the follow-up on an ongoing one. Notes live at
// users/{uid}/feedbackNotes/{id}, readable by their owner and written only
// here and by the plan update (generateProgram.ts, or groupProgram.ts for a
// group member, whose own layer works around them).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  normalizeNoteGroupInput, noteGroupKey, MAX_PENDING_NOTES, MAX_ACTIVE_NOTES, FOLLOW_UP_OUTCOMES, FollowUpOutcome, followUpChange,
} from "../lib/planFeedback";

const notesOf = (uid: string) => getFirestore().collection(`users/${uid}/feedbackNotes`);

/**
 * Refuses `adding` more notes past either limit (only the in-play one for a
 * note coming back into play, which isn't waiting). Answers to check-in
 * questions have their own limit (checkin/checkinQuestions.ts).
 */
async function checkRoom(uid: string, adding: number, { activeOnly = false } = {}): Promise<void> {
  if (adding <= 0) return;
  const notes = notesOf(uid);
  const answers = notes.where("source", "==", "checkin_question");
  const counts = await Promise.all([
    notes.where("status", "==", "pending").count().get(),
    answers.where("status", "==", "pending").count().get(),
    notes.where("status", "in", ["pending", "open"]).count().get(),
    answers.where("status", "in", ["pending", "open"]).count().get(),
  ]);
  const [pendingCount, activeCount] = [counts[0].data().count - counts[1].data().count, counts[2].data().count - counts[3].data().count];
  const more = adding === 1 ? "" : ` There's room for ${Math.max(0, Math.min(MAX_PENDING_NOTES - pendingCount, MAX_ACTIVE_NOTES - activeCount))} more.`;
  if (!activeOnly && pendingCount + adding > MAX_PENDING_NOTES) {
    throw new HttpsError("resource-exhausted", `You can have ${MAX_PENDING_NOTES} notes waiting. Update your plan first, then add more.${more}`);
  }
  if (activeCount + adding > MAX_ACTIVE_NOTES) {
    throw new HttpsError("resource-exhausted", `Your plan can work around ${MAX_ACTIVE_NOTES} notes at once. Mark some as better at check-in, then add more.${more}`);
  }
}

const newNote = (note: object, groupId: string) => ({
  ...note,
  groupId,
  status: "pending",
  source: "checkin",
  worse: false,
  createdAt: FieldValue.serverTimestamp(),
});

/** Saves a note card: one note per exercise it names, all in one new group. */
export const addFeedbackNote = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const normalized = normalizeNoteGroupInput(request.data);
  if ("error" in normalized) throw new HttpsError("invalid-argument", normalized.error);
  await checkRoom(uid, normalized.notes.length);

  const notes = notesOf(uid);
  const groupId = notes.doc().id;
  const batch = getFirestore().batch();
  const refs = normalized.notes.map((note) => {
    const ref = notes.doc();
    batch.set(ref, newNote(note, groupId));
    return ref;
  });
  await batch.commit();
  return { noteId: refs[0].id, noteIds: refs.map((r) => r.id), groupId };
});

const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9]{1,40}$/.test(id);

const noteRef = (uid: string, noteId: unknown) => {
  if (!validId(noteId)) throw new HttpsError("invalid-argument", "Unknown note.");
  return notesOf(uid).doc(noteId);
};

const groupQuery = (uid: string, groupId: unknown) => {
  if (!validId(groupId)) throw new HttpsError("invalid-argument", "Unknown note.");
  return notesOf(uid).where("groupId", "==", groupId);
};

const USED = "That note has already been used in a plan update.";

/**
 * Takes back a note the next update hasn't used yet, or with `groupId`
 * every waiting note of a card.
 */
export const removeFeedbackNote = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  if (request.data?.groupId !== undefined) {
    const group = groupQuery(uid, request.data.groupId);
    await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(group);
      const waiting = snap.docs.filter((d) => d.get("status") === "pending");
      if (!waiting.length && !snap.empty) throw new HttpsError("failed-precondition", USED);
      waiting.forEach((d) => tx.delete(d.ref));
    });
    return { ok: true };
  }
  const ref = noteRef(uid, request.data?.noteId);
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return; // already gone
    if (snap.get("status") !== "pending") throw new HttpsError("failed-precondition", USED);
    tx.delete(ref);
  });
  return { ok: true };
});

/**
 * Edits a card's waiting notes: the kept exercises take the new tags, text
 * and duration, unticked ones are removed, and newly ticked ones join the
 * group. Each note keeps its id, so the Program page's tag stays on it.
 */
export const updateFeedbackNoteGroup = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const groupId = request.data?.groupId;
  const group = groupQuery(uid, groupId);
  const normalized = normalizeNoteGroupInput(request.data);
  if ("error" in normalized) throw new HttpsError("invalid-argument", normalized.error);

  // Checked against the group as it stands; the transaction re-reads it.
  const before = (await group.where("status", "==", "pending").count().get()).data().count;
  if (!before) throw new HttpsError("failed-precondition", USED);
  await checkRoom(uid, normalized.notes.length - before);

  const notes = notesOf(uid);
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(group);
    const waiting = new Map(snap.docs.filter((d) => d.get("status") === "pending")
      .map((d) => [noteGroupKey({ day: d.get("day") ?? null, exercise: d.get("exercise") ?? null }), d]));
    if (!waiting.size) throw new HttpsError("failed-precondition", USED);
    for (const note of normalized.notes) {
      const existing = waiting.get(noteGroupKey(note));
      if (existing) {
        tx.update(existing.ref, { tags: note.tags, text: note.text, duration: note.duration });
        waiting.delete(noteGroupKey(note));
      } else {
        tx.set(notes.doc(), newNote(note, groupId));
      }
    }
    waiting.forEach((d) => tx.delete(d.ref));
  });
  return { ok: true };
});

/** A note an answer can still be given or changed on: ongoing, or "better" the update hasn't told yet. */
const followable = (status: unknown, announced: unknown) => status === "open" || (status === "resolved" && announced === false);

/**
 * Records follow-up answers on ongoing notes: still a problem, better, or
 * worse. The check-in sends them with Update plan (queueProgramGeneration),
 * so they're in place before the update reads the notes. A note that's no
 * longer waiting for one (taken back, or already settled) is passed over.
 */
export async function recordFollowUps(uid: string, raw: unknown): Promise<void> {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw) || raw.length > MAX_ACTIVE_NOTES) throw new HttpsError("invalid-argument", "Unknown answer.");
  const answers = new Map<string, FollowUpOutcome>();
  for (const a of raw as Array<{ noteId?: unknown; outcome?: unknown }>) {
    if (!validId(a?.noteId) || !FOLLOW_UP_OUTCOMES.includes(a?.outcome as FollowUpOutcome)) {
      throw new HttpsError("invalid-argument", "Unknown answer.");
    }
    answers.set(a.noteId, a.outcome as FollowUpOutcome);
  }
  if (!answers.size) return;
  const refs = [...answers.keys()].map((id) => notesOf(uid).doc(id));
  // Taking back "better" puts a note back in play, so it needs room.
  const reopening = (await getFirestore().getAll(...refs))
    .filter((d) => d.get("status") === "resolved" && d.get("announced") === false && answers.get(d.id) !== "better").length;
  await checkRoom(uid, reopening, { activeOnly: true });
  await getFirestore().runTransaction(async (tx) => {
    const snaps = await tx.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists || !followable(snap.get("status"), snap.get("announced"))) continue;
      const outcome = answers.get(snap.id)!;
      tx.update(snap.ref, {
        announced: FieldValue.delete(), // set again by "better"
        ...followUpChange(outcome),
        lastFollowUp: outcome,
        followedUpAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

/** One follow-up answer, saved straight away (check-in pages from before answers went with Update plan). */
export const followUpFeedbackNote = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const ref = noteRef(request.auth.uid, request.data?.noteId);
  const outcome = request.data?.outcome;
  if (!FOLLOW_UP_OUTCOMES.includes(outcome)) throw new HttpsError("invalid-argument", "Unknown answer.");
  const snap = await ref.get();
  if (!snap.exists || !followable(snap.get("status"), snap.get("announced"))) {
    throw new HttpsError("failed-precondition", "That note isn't waiting for a follow-up.");
  }
  await recordFollowUps(request.auth.uid, [{ noteId: ref.id, outcome }]);
  return { ok: true };
});
