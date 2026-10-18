// The check-in's questions about the data (see lib/checkinQuestions.ts):
// work out when the plan last read the logs and what Hevy has, build the
// questions, and save an answer as a feedback note, which the next plan
// update reads like any other (lib/planFeedback.ts) and answers in What
// changed. On a group plan the member's own layer is what read their logs
// (generate/groupProgram.ts).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Firestore, DocumentData } from "firebase-admin/firestore";
import { buildCheckinQuestions, answerGuidance, planHasLifts, CheckinQuestion, CheckinInput } from "../lib/checkinQuestions";
import { daysBetween } from "../lib/checkinFormat";
import { storedSessionDate } from "../lib/hevyAnalyzer";
import { NOTE_TEXT_MAX } from "../lib/planFeedback";

/** An answered question isn't asked again for this long. */
const ANSWERED_FOR_DAYS = 42;
/** Answers waiting for the next update; there are only ever a couple of questions. */
export const MAX_PENDING_ANSWERS = 15;
/** Newest stored workouts read, to check the import status against. */
const RECENT_WORKOUTS = 5;

const asDate = (v: unknown, fallback: string): string => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback);

/**
 * The athlete's clock, from the page: their date and their offset from UTC
 * (minutes, as Date.getTimezoneOffset gives it). A day name is only right in
 * their time zone, so "today" and the times the plan and Hevy import
 * happened are all read as their dates. Anything implausible falls back to UTC.
 */
interface AthleteClock { today: string; offsetMin: number }

function athleteClock(data: Record<string, unknown> | undefined): AthleteClock {
  const server = new Date().toISOString().slice(0, 10);
  const today = asDate(data?.today, server);
  const raw = data?.tzOffset;
  const offsetMin = Number.isInteger(raw) && Math.abs(raw as number) <= 14 * 60 ? (raw as number) : 0;
  return Math.abs(daysBetween(server, today)) <= 1 ? { today, offsetMin } : { today: server, offsetMin: 0 };
}

/** A stored time as the athlete's date. */
function localDate(ts: { toMillis?: () => number } | null | undefined, clock: AthleteClock): string | null {
  const ms = ts?.toMillis?.();
  return ms != null ? new Date(ms - clock.offsetMin * 60000).toISOString().slice(0, 10) : null;
}

interface Loaded {
  questions: CheckinQuestion[];
  /** Keys answered earlier, by the note doc that holds the answer. */
  answered: Map<string, { noteId: string; status: string; answerId: string }>;
}

/** When the plan last read the logs, and whether it has lifting in it. */
interface PlanForQuestions {
  readAt: { toMillis?: () => number } | null;
  hasLifts: boolean;
}

async function personalPlan(db: Firestore, uid: string, summary: DocumentData): Promise<PlanForQuestions> {
  const snap = summary.currentProgramId ? await db.doc(`users/${uid}/programs/${summary.currentProgramId}`).get() : null;
  const program = snap?.exists ? snap.data() ?? null : null;
  // Older plans only have when they were saved.
  return { readAt: program?.inputsReadAt ?? program?.createdAt ?? null, hasLifts: planHasLifts(program?.sessions) };
}

const millis = (ts: { toMillis?: () => number } | null | undefined): number => ts?.toMillis?.() ?? -Infinity;

async function groupPlan(db: Firestore, uid: string, groupId: string): Promise<PlanForQuestions> {
  const [programSnap, memberSnap] = await Promise.all([
    db.collection(`groups/${groupId}/programs`).where("status", "==", "active").limit(1).get(),
    db.doc(`groups/${groupId}/members/${uid}`).get(),
  ]);
  const shared = programSnap.docs[0]?.data() ?? null;
  const member = memberSnap.data() ?? null;
  // Logs from before the shared plan started were done on the one it replaced
  // (another member's update can replace it after this member's last one), and
  // a member's first update hasn't read their logs yet. A layer written before
  // inputsReadAt existed only has when it was written.
  const layerReadAt = member?.inputsReadAt ?? member?.updatedAt;
  const readAt = millis(layerReadAt) >= millis(shared?.createdAt) ? layerReadAt : shared?.createdAt;
  return { readAt: readAt ?? null, hasLifts: planHasLifts(shared?.sessions) };
}

async function loadQuestions(db: Firestore, uid: string, clock: AthleteClock): Promise<Loaded> {
  const summary = (await db.doc(`users/${uid}/state/summary`).get()).data() ?? {};
  const [current, recent] = await Promise.all([
    summary.activeProgramSource === "group" && summary.groupId ? groupPlan(db, uid, summary.groupId) : personalPlan(db, uid, summary),
    db.collection(`users/${uid}/strengthSessions`).orderBy("date", "desc").limit(RECENT_WORKOUTS).get(),
  ]);
  const newest = recent.docs.map((d) => storedSessionDate(d.get("start_time"), d.get("date"))).sort().pop() ?? null;
  const questions = buildCheckinQuestions({
    today: clock.today,
    planReadDate: localDate(current.readAt, clock),
    planHasLifts: current.hasLifts,
    hevy: hevyStatus(summary.integrationsStatus?.hevy ?? {}, newest),
  });

  const answered: Loaded["answered"] = new Map();
  const keys = questions.map((q) => q.key);
  if (keys.length) {
    const oldest = Date.now() - ANSWERED_FOR_DAYS * 86400000;
    const snap = await db.collection(`users/${uid}/feedbackNotes`).where("questionKey", "in", keys).get();
    for (const d of snap.docs) {
      const n = d.data();
      if (n.status !== "pending" && (n.createdAt?.toMillis?.() ?? 0) < oldest) continue;
      answered.set(n.questionKey, { noteId: d.id, status: n.status, answerId: n.answerId });
    }
  }
  return { questions, answered };
}

/**
 * What the summary says about the last Hevy import, but never older than the
 * workouts actually stored: an import whose closing status write failed (or
 * predates it) has saved its sessions without saying so.
 */
function hevyStatus(hevy: DocumentData, newest: string | null): CheckinInput["hevy"] {
  const stated: string | null = hevy.lastSessionDate ?? null;
  return {
    used: hevy.csvUploaded === true || newest != null,
    lastSessionDate: stated && newest ? (stated > newest ? stated : newest) : stated ?? newest,
  };
}

/**
 * The questions for this check-in. One answered in an earlier check-in is
 * dropped; one answered since the last update comes back with its answer,
 * so it can be changed.
 */
export const getCheckinQuestions = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { questions, answered } = await loadQuestions(getFirestore(), uid, athleteClock(request.data));
  const open = (q: CheckinQuestion) => answered.get(q.key)?.status === "pending" || !answered.has(q.key);
  return {
    questions: questions.filter(open).map((q) => {
      const a = answered.get(q.key);
      return {
        key: q.key, kind: q.kind, source: q.source, text: q.text, answers: q.answers,
        answer: a ? { noteId: a.noteId, answerId: a.answerId } : null,
      };
    }),
  };
});

function readText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string" || raw.length > NOTE_TEXT_MAX) throw new HttpsError("invalid-argument", "Keep it under 1,000 characters.");
  return raw.trim();
}

/**
 * Save (or change) the answer to one question, as a note for the next plan
 * update. The question is rebuilt from the logs, so only a question the app
 * asked can be answered, with one of its own answers.
 */
export const answerCheckinQuestion = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const db = getFirestore();
  const key = request.data?.key;
  const answerId = request.data?.answerId;
  if (typeof key !== "string" || typeof answerId !== "string") throw new HttpsError("invalid-argument", "Unknown answer.");

  const { questions, answered } = await loadQuestions(db, uid, athleteClock(request.data));
  const q = questions.find((x) => x.key === key);
  if (!q) throw new HttpsError("failed-precondition", "That question no longer applies. Reload the page to see the current ones.");
  const guidance = answerGuidance(q, answerId);
  if (!guidance) throw new HttpsError("invalid-argument", "Unknown answer.");
  const answer = q.answers.find((a) => a.id === answerId)!;
  const note = {
    tags: ["checkin"],
    text: answer.details ? readText(request.data?.text) : "",
    exercise: null,
    day: null,
    duration: "week",
    checkin: { question: q.text, answer: answer.label, guidance },
    questionKey: q.key,
    answerId,
  };

  const earlier = answered.get(key);
  const notes = db.collection(`users/${uid}/feedbackNotes`);
  const noteId = await db.runTransaction(async (tx) => {
    if (earlier) {
      const ref = notes.doc(earlier.noteId);
      const snap = await tx.get(ref);
      if (snap.exists && snap.get("status") !== "pending") {
        throw new HttpsError("failed-precondition", "That answer has already gone into a plan update.");
      }
      if (snap.exists) {
        tx.update(ref, { ...note, updatedAt: FieldValue.serverTimestamp() });
        return ref.id;
      }
    }
    const pending = await tx.get(notes.where("status", "==", "pending").where("source", "==", "checkin_question").count());
    if (pending.data().count >= MAX_PENDING_ANSWERS) {
      throw new HttpsError("resource-exhausted", "That's plenty for this update. Update your plan first, then answer more.");
    }
    const ref = notes.doc();
    tx.set(ref, { ...note, status: "pending", source: "checkin_question", worse: false, createdAt: FieldValue.serverTimestamp() });
    return ref.id;
  });
  return { noteId };
});
