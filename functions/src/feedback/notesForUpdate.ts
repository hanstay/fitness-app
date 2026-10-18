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
 * update was given. A note that changed while the update ran (taken back, or
 * answered at a follow-up) is left as it now is.
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
    const unchanged = snap.exists && snap.get("status") === notes[i].status && (snap.get("worse") === true) === (notes[i].worse === true);
    if (!unchanged) return;
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
