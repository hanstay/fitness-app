// The check-in's "Your week" questions (see lib/checkinQuestions.ts): load
// the plan and the last few weeks of logs, build the questions, and save an
// answer as a feedback note, which the next plan update reads like any other
// (lib/planFeedback.ts) and answers in What changed. Personal plans only, as
// with notes: a group plan is written for the whole group.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Firestore } from "firebase-admin/firestore";
import {
  buildCheckinQuestions, answerGuidance, CheckinQuestion, CheckinQuestions, LoggedActivity, CheckinPlan, MAX_SHOWN,
} from "../lib/checkinQuestions";
import { addDays, daysBetween } from "../lib/checkinFormat";
import type { StrengthSession } from "../lib/hevyDerivedData";
import { FeedbackTag, NOTE_TEXT_MAX } from "../lib/planFeedback";

/** How far back the logs are read: the detail week plus 4 weeks of patterns. */
const HISTORY_DAYS = 35;
/** An answered question isn't asked again for this long. */
const ANSWERED_FOR_DAYS = 42;
/** Answers waiting for the next update; questions are capped well below this. */
export const MAX_PENDING_ANSWERS = 15;

const PAIN_AREAS = ["Knee", "Lower back", "Hip", "Shoulder", "Elbow", "Wrist", "Ankle", "Other"] as const;
const PAIN_LEVELS = ["A niggle", "Sore", "Sharp"] as const;

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
  questions: CheckinQuestions;
  /** Keys answered earlier, by the note doc that holds the answer. */
  answered: Map<string, { noteId: string; status: string; answerId: string; followUpId: string | null }>;
}

async function loadQuestions(db: Firestore, uid: string, clock: AthleteClock): Promise<Loaded> {
  const { today } = clock;
  const summary = (await db.doc(`users/${uid}/state/summary`).get()).data() ?? {};
  if (summary.activeProgramSource === "group" && summary.groupId) {
    throw new HttpsError("failed-precondition", "Check-in questions aren't available on group plans yet.");
  }
  const since = addDays(today, -HISTORY_DAYS);
  const [programSnap, userSnap, strengthSnap, activitySnap] = await Promise.all([
    summary.currentProgramId ? db.doc(`users/${uid}/programs/${summary.currentProgramId}`).get() : Promise.resolve(null),
    db.doc(`users/${uid}`).get(),
    db.collection(`users/${uid}/strengthSessions`).where("date", ">=", since).get(),
    db.collection(`users/${uid}/activities`).where("date", ">=", since).get(),
  ]);
  const program = programSnap?.exists ? programSnap.data() ?? null : null;
  // The time the plan read the logs (see plan-update-readiness.js); older
  // plans only have when they were saved.
  const planReadDate = localDate(program?.inputsReadAt ?? program?.createdAt, clock);
  const hevy = summary.integrationsStatus?.hevy ?? {};
  const strength = strengthSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as StrengthSession);
  const activities: LoggedActivity[] = activitySnap.docs.map((d) => {
    const a = d.data();
    return {
      id: d.id, date: a.date ?? null, type: a.type ?? "Other", name: a.name ?? null,
      distance_km: a.distance_km ?? null, duration_s: a.duration_s ?? null, avg_hr: a.avg_hr ?? null, hrZones: a.hrZones ?? null,
    };
  });

  const questions = buildCheckinQuestions({
    today,
    planReadDate,
    planSince: localDate(program?.blockStartedAt ?? program?.createdAt, clock),
    plan: program as CheckinPlan | null,
    fixedSessions: userSnap.data()?.athlete?.fixed_sessions ?? [],
    strength,
    activities,
    tsb: typeof summary.wellness?.tsb === "number" ? summary.wellness.tsb : null,
    hevy: { used: hevy.csvUploaded === true, lastSessionDate: hevy.lastSessionDate ?? null, importedDate: localDate(hevy.parsedAt, clock) },
    icuConnected: summary.integrationsStatus?.intervalsIcu?.connected === true,
  });

  // Earlier answers to these questions, in groups of 30 (Firestore's "in" limit).
  const all = allQuestions(questions);
  const keys = all.map((q) => q.key);
  const answered: Loaded["answered"] = new Map();
  const oldest = Date.now() - ANSWERED_FOR_DAYS * 86400000;
  for (let i = 0; i < keys.length; i += 30) {
    const snap = await db.collection(`users/${uid}/feedbackNotes`).where("questionKey", "in", keys.slice(i, i + 30)).get();
    for (const d of snap.docs) {
      const n = d.data();
      if (n.status !== "pending" && (n.createdAt?.toMillis?.() ?? 0) < oldest) continue;
      answered.set(n.questionKey, { noteId: d.id, status: n.status, answerId: n.answerId, followUpId: n.followUpId ?? null });
    }
  }
  return { questions, answered };
}

const allQuestions = (q: CheckinQuestions): CheckinQuestion[] => [...(q.gap ? [q.gap] : []), ...q.data, ...q.week, ...q.more];

/**
 * The questions for this check-in. One answered in an earlier check-in is
 * dropped; one answered since the last update comes back with its answer,
 * so it can be changed.
 */
export const getCheckinQuestions = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { questions, answered } = await loadQuestions(getFirestore(), uid, athleteClock(request.data));

  const view = (q: CheckinQuestion) => {
    const a = answered.get(q.key);
    return {
      key: q.key, kind: q.kind, source: q.source, text: q.text, facts: q.facts, answers: q.answers,
      answer: a ? { noteId: a.noteId, answerId: a.answerId, followUpId: a.followUpId } : null,
    };
  };
  const open = (q: CheckinQuestion) => answered.get(q.key)?.status === "pending" || !answered.has(q.key);
  // An earlier check-in's answers drop out, and the next questions move up.
  const ranked = [...questions.week, ...questions.more].filter(open);
  return {
    gap: questions.gap && open(questions.gap) ? view(questions.gap) : null,
    data: questions.data.filter(open).map(view),
    week: ranked.slice(0, MAX_SHOWN).map(view),
    more: ranked.slice(MAX_SHOWN).map(view),
  };
});

interface PainInput { area: string; level: string; duration: "week" | "ongoing"; text: string }

function readPain(raw: unknown): PainInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!PAIN_AREAS.includes(r.area as (typeof PAIN_AREAS)[number]) || !PAIN_LEVELS.includes(r.level as (typeof PAIN_LEVELS)[number])) {
    throw new HttpsError("invalid-argument", "Say where it hurts and how bad it is.");
  }
  return {
    area: r.area as string,
    level: r.level as string,
    duration: r.duration === "ongoing" ? "ongoing" : "week",
    text: readText(r.text),
  };
}

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
  const followUpId = typeof request.data?.followUpId === "string" ? request.data.followUpId : null;
  if (typeof key !== "string" || typeof answerId !== "string") throw new HttpsError("invalid-argument", "Unknown answer.");

  const { questions, answered } = await loadQuestions(db, uid, athleteClock(request.data));
  const q = allQuestions(questions).find((x) => x.key === key);
  if (!q) throw new HttpsError("failed-precondition", "That question no longer applies. Reload the page to see this week's.");
  const guidance = answerGuidance(q, answerId, followUpId);
  if (!guidance) throw new HttpsError("invalid-argument", "Unknown answer.");
  const answer = q.answers.find((a) => a.id === answerId)!;
  const followUpLabel = answer.followUp?.answers.find((f) => f.id === followUpId)?.label;

  const pain = answer.pain ? readPain(request.data?.pain) : null;
  const text = pain
    ? [`${pain.area}, ${pain.level.toLowerCase()}.`, pain.text].filter(Boolean).join(" ")
    : answer.details ? readText(request.data?.text) : "";
  const tags: FeedbackTag[] = pain ? ["pain", "checkin"] : ["checkin"];
  const note = {
    tags,
    text,
    exercise: q.exercise,
    day: q.day,
    duration: pain?.duration ?? "week",
    checkin: { question: q.text, answer: followUpLabel ? `${answer.label}: ${followUpLabel}` : answer.label, guidance },
    questionKey: q.key,
    answerId,
    followUpId: answer.followUp ? followUpId : null,
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
