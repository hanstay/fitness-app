// The weekly update's reads and writes of feedback notes (see
// lib/planFeedback.ts for what the statuses mean).
import { Firestore, FieldValue, Transaction } from "firebase-admin/firestore";
import { ACTIVE_NOTE_STATUSES, ActiveNote, NoteSettlement, readActiveNote } from "../lib/planFeedback";

/**
 * Every note in play, oldest first. Not capped here: adding notes is
 * (MAX_ACTIVE_NOTES), and an update must see every open note so swaps made
 * for them aren't put back.
 */
export async function loadActiveNotes(db: Firestore, uid: string): Promise<ActiveNote[]> {
  const snap = await db.collection(`users/${uid}/feedbackNotes`).where("status", "in", ACTIVE_NOTE_STATUSES).get();
  return snap.docs
    .map((d) => ({ note: readActiveNote(d.id, d.data()), at: d.get("createdAt")?.toMillis?.() ?? 0 }))
    .filter((n): n is { note: ActiveNote; at: number } => n.note != null)
    .sort((a, b) => a.at - b.at)
    .map((n) => n.note);
}

/**
 * Inside the update's commit, after its other reads: moves on each note the
 * update was given. A note that changed while the update ran (taken back,
 * answered at a follow-up, or edited at check-in) is left as it now is, for
 * the next update.
 */
export async function settleNotesInTransaction(
  db: Firestore,
  tx: Transaction,
  uid: string,
  notes: ActiveNote[],
  settlements: NoteSettlement[],
  programId: string
): Promise<void> {
  if (!notes.length) return;
  const refs = notes.map((n) => db.doc(`users/${uid}/feedbackNotes/${n.id}`));
  const snaps = await tx.getAll(...refs);
  settlements.forEach((s, i) => {
    const snap = snaps[i];
    if (!snap.exists || !sameNote(readActiveNote(snap.id, snap.data() ?? {}), notes[i])) return;
    tx.update(refs[i], {
      status: s.status,
      response: s.response,
      worse: false,
      handledAt: FieldValue.serverTimestamp(),
      handledProgramId: programId,
      ...(s.status === "resolved" ? { announced: true } : {}),
    });
  });
}

// What the update read is still what the note says.
const sameNote = (now: ActiveNote | null, read: ActiveNote): boolean =>
  now != null && now.status === read.status && now.worse === (read.worse === true) &&
  now.text === read.text && now.duration === read.duration && now.tags.join() === read.tags.join();
