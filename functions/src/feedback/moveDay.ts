// The Program page's "Rearrange week": saves a new order for the current
// week's days at once, with no model call (see lib/moveDay.ts). On a personal
// plan it edits the athlete's current program doc in place; on a group plan
// only the leader can rearrange it, and it moves the shared week for every
// member, their loads and waiting notes with it. Either way the program records `weekEditedAt`, so an
// update already running when the day moved doesn't write over it
// (generateProgram.ts, groupProgram.ts).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import { WEEKDAYS, Weekday } from "../lib/days";
import { DayMoves, moveWeekDays, fixedSessionMoved, moveDayName, readMoves, swapMoves, withDaysMoved } from "../lib/moveDay";
import { SwapRecord } from "../lib/exerciseSwap";
import { SessionLoadsOutput } from "../lib/schemas";
import { isStaleGeneration } from "../lib/staleGeneration";

const PLAN_REPLACED = "Your plan has changed since this page loaded. Reload it and try again.";

const asWeekday = (v: unknown): Weekday => {
  const day = typeof v === "string" && (WEEKDAYS as readonly string[]).includes(v) ? (v as Weekday) : null;
  if (!day) throw new HttpsError("invalid-argument", "Pick a day of the week.");
  return day;
};

const updating = (summary: DocumentSnapshot) =>
  summary.get("programGenerationStatus") === "generating" &&
  !isStaleGeneration(summary.get("programGenerationStartedAt")?.toDate() ?? null, Date.now());

/** Refuses a move onto or off a day with a fixed session, which the next update would put back. */
function checkFixedSessions(fixed: Array<{ day: string; activity: string }> | undefined, moves: DayMoves, where: string) {
  const clash = fixedSessionMoved(fixed, moves);
  if (clash) {
    throw new HttpsError("failed-precondition", `${clash.activity} is fixed on ${clash.day}. To move it, change the fixed sessions in ${where}.`);
  }
}

/**
 * Moves the day on the notes waiting for the next update (by `uid`), read in
 * `tx`, so each still points at its exercise's day. Notes already acted on
 * are about the week they were written for, and stay as they are.
 */
async function moveWaitingNotes(db: Firestore, tx: Transaction, uids: string[], moves: DayMoves) {
  const notes = await Promise.all(uids.map((uid) =>
    tx.get(db.collection(`users/${uid}/feedbackNotes`).where("status", "==", "pending"))));
  return () => {
    for (const snap of notes) {
      for (const note of snap.docs) {
        const day = note.get("day");
        if (typeof day !== "string") continue;
        const moved = moveDayName(day, moves);
        if (moved !== day) tx.update(note.ref, { day: moved });
      }
    }
  };
}

export const moveProgramDay = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const programId = request.data?.programId;
  if (typeof programId !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(programId)) throw new HttpsError("invalid-argument", "Unknown plan.");
  // `moves` is the whole new order; { from, to } is the older swap of two
  // days, still sent by a page cached before Rearrange week.
  let moves: DayMoves | null;
  if (request.data?.moves !== undefined) {
    moves = readMoves(request.data.moves);
    if (!moves) throw new HttpsError("invalid-argument", "Move at least one session to another day.");
  } else {
    const from = asWeekday(request.data?.from);
    const to = asWeekday(request.data?.to);
    if (from === to) throw new HttpsError("invalid-argument", "Pick a different day to move it to.");
    moves = swapMoves(from, to);
  }

  const db = getFirestore();
  const summary = await db.doc(`users/${uid}/state/summary`).get();
  const groupId = summary.get("activeProgramSource") === "group" ? summary.get("groupId") : null;
  return groupId ? moveGroupDay(db, uid, groupId, programId, moves) : movePersonalDay(db, uid, programId, moves);
});

async function movePersonalDay(db: Firestore, uid: string, programId: string, moves: DayMoves) {
  const userRef = db.doc(`users/${uid}`);
  const summaryRef = db.doc(`users/${uid}/state/summary`);
  const programRef = db.doc(`users/${uid}/programs/${programId}`);
  await db.runTransaction(async (tx) => {
    const [user, summary, program] = await tx.getAll(userRef, summaryRef, programRef);
    // The program this page showed, and not about to be replaced by an update
    // that's running now (which would drop the move).
    if (!program.exists || program.get("status") !== "active" || summary.get("currentProgramId") !== program.id) {
      throw new HttpsError("failed-precondition", PLAN_REPLACED);
    }
    if (updating(summary)) throw new HttpsError("failed-precondition", "Your plan is being updated right now. Try again once it's done.");
    checkFixedSessions(user.get("athlete")?.fixed_sessions, moves, "your profile");
    const week = moveWeekDays(program.data()!, moves);
    if (!week) throw new HttpsError("failed-precondition", "This plan's days can't be moved. Update your plan first.");

    const writeNotes = await moveWaitingNotes(db, tx, [uid], moves);
    tx.update(programRef, {
      ...week,
      swaps: withDaysMoved((program.get("swaps") ?? []) as SwapRecord[], moves),
      weekEditedAt: FieldValue.serverTimestamp(),
    });
    writeNotes();
  });
  return { ok: true };
}

async function moveGroupDay(db: Firestore, uid: string, groupId: string, programId: string, moves: DayMoves) {
  const groupRef = db.doc(`groups/${groupId}`);
  const programRef = db.doc(`groups/${groupId}/programs/${programId}`);
  await db.runTransaction(async (tx) => {
    const [group, program] = await tx.getAll(groupRef, programRef);
    if (!group.exists) throw new HttpsError("failed-precondition", PLAN_REPLACED);
    if (group.get("leaderUid") !== uid) {
      throw new HttpsError("permission-denied", "Only your group's leader can rearrange the group plan's week.");
    }
    if (!program.exists || program.get("status") !== "active") throw new HttpsError("failed-precondition", PLAN_REPLACED);
    checkFixedSessions(group.get("fixedSessions"), moves, "your group's settings");
    const week = moveWeekDays(program.data()!, moves);
    if (!week) throw new HttpsError("failed-precondition", "This plan's days can't be moved. Update your plan first.");

    // Only members following the group plan train on its days; one who has
    // switched to their own plan keeps their notes, and can update it freely.
    const memberUids: string[] = group.get("memberUids") ?? [];
    const summaries = memberUids.length ? await tx.getAll(...memberUids.map((m) => db.doc(`users/${m}/state/summary`))) : [];
    const following = summaries.filter((s) => s.get("activeProgramSource") === "group" && s.get("groupId") === groupId);
    const members = memberUids.length ? await tx.getAll(...memberUids.map((m) => db.doc(`groups/${groupId}/members/${m}`))) : [];
    // A member's update running now writes their loads for the old days.
    if (following.some(updating)) {
      throw new HttpsError("failed-precondition", "A plan update is running for someone in your group. Try again once it's done.");
    }

    const writeNotes = await moveWaitingNotes(db, tx, following.map((s) => s.ref.parent.parent!.id), moves);
    tx.update(programRef, { ...week, weekEditedAt: FieldValue.serverTimestamp() });
    // Loads written for an earlier shared week no longer match it either way.
    for (const member of members) {
      if (!member.exists || member.get("groupProgramId") !== programId) continue;
      const loads = member.get("sessionLoads") as SessionLoadsOutput | undefined;
      if (Array.isArray(loads)) tx.update(member.ref, { sessionLoads: withDaysMoved(loads, moves) });
    }
    writeNotes();
  });
  return { ok: true };
}

