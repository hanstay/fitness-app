// Emulator-backed: the check-in's "Your week" callables
// (checkin/checkinQuestions.ts). No LLM is involved. See functions/test/README.md
// for how to run this.
import { describe, it, expect, beforeEach } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { getCheckinQuestions, answerCheckinQuestion, MAX_PENDING_ANSWERS } from "../src/checkin/checkinQuestions";
import { removeFeedbackNote } from "../src/feedback/feedbackNotes";
import { loadActiveNotes } from "../src/feedback/notesForUpdate";
import { formatFeedbackBlock } from "../src/lib/planFeedback";

const db = getTestDb();

type Callable = { run: (req: unknown) => Promise<unknown> };
const call = <T = Record<string, unknown>>(fn: Callable, uid: string, data: unknown) =>
  fn.run({ auth: { uid }, data }) as Promise<T>;

interface View { key: string; kind: string; text: string; answers: Array<{ id: string }>; answer: { noteId: string; answerId: string } | null }
interface Questions { gap: View | null; data: View[]; week: View[]; more: View[] }

// The athlete's today, so the test doesn't depend on when it runs.
const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const weekdayOf = (date: string) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${date}T00:00:00Z`).getUTCDay()];

const ex = (name: string) => ({ name, sets: 3, reps: "6-8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null });

/** A plan read 6 days ago with a Lower session 3 days ago, which was done with Goblet Squat instead. */
async function seed(uid: string, summary: Record<string, unknown> = {}) {
  const day = daysAgo(3);
  await db.doc(`users/${uid}`).set({ uid, athlete: { goal: "Get stronger" } });
  const program = db.collection(`users/${uid}/programs`).doc();
  await program.set({
    status: "active",
    inputsReadAt: Timestamp.fromMillis(Date.now() - 6 * 86400000),
    sessions: [{ day: weekdayOf(day), label: "Lower", focus_note: null, exercises: [ex("Squat (Barbell)")] }],
  });
  await db.doc(`users/${uid}/state/summary`).set({
    activeProgramSource: "personal",
    currentProgramId: program.id,
    integrationsStatus: { hevy: { csvUploaded: true, lastSessionDate: day } },
    ...summary,
  });
  await db.doc(`users/${uid}/strengthSessions/s1`).set({
    date: day, title: "Lower", start_time: `${day} 18:00`, end_time: `${day} 19:00`, source: "hevy",
    exercises: [{ name: "Goblet Squat", sets: [0, 1, 2].map((index) => ({ index, type: "normal", weight_kg: 30, reps: 10, distance_km: null, duration_seconds: null, rpe: null })) }],
  });
  return { day, programId: program.id };
}

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe("check-in questions", () => {
  it("asks about the swap, saves the answer as a note for the update, and lets it be changed or taken back", async () => {
    const { day } = await seed("q1");
    const first = await call<Questions>(getCheckinQuestions, "q1", { today: TODAY });
    expect(first.week).toHaveLength(1);
    const q = first.week[0];
    expect(q.kind).toBe("swapped_exercise");
    expect(q.text).toBe(`You did Goblet Squat instead of Squat (Barbell) on ${weekdayOf(day)}. Why?`);

    const { noteId } = await call<{ noteId: string }>(answerCheckinQuestion, "q1", { key: q.key, answerId: "prefer", today: TODAY });
    const saved = (await db.doc(`users/q1/feedbackNotes/${noteId}`).get()).data();
    expect(saved).toMatchObject({
      status: "pending", source: "checkin_question", tags: ["checkin"], questionKey: q.key, answerId: "prefer",
      exercise: "Squat (Barbell)", day: weekdayOf(day), duration: "week",
      checkin: { question: q.text, answer: "Prefer it" },
    });

    // The update sees it with the app's guidance.
    const block = formatFeedbackBlock(await loadActiveNotes(db, "q1"));
    expect(block).toContain(`answered "Prefer it". To do: They prefer Goblet Squat: make it the plan's exercise in place of Squat (Barbell)`);

    // Asked again with its answer, and changing it updates the same note.
    const again = await call<Questions>(getCheckinQuestions, "q1", { today: TODAY });
    expect(again.week[0].answer).toMatchObject({ noteId, answerId: "prefer" });
    await call(answerCheckinQuestion, "q1", { key: q.key, answerId: "once", today: TODAY });
    const notes = await db.collection("users/q1/feedbackNotes").get();
    expect(notes.docs.map((d) => [d.id, d.get("answerId")])).toEqual([[noteId, "once"]]);

    await call(removeFeedbackNote, "q1", { noteId });
    expect((await db.collection("users/q1/feedbackNotes").get()).size).toBe(0);
  });

  it("saves a pain answer as a pain note that's followed up if it's ongoing", async () => {
    await seed("q2");
    const [q] = (await call<Questions>(getCheckinQuestions, "q2", { today: TODAY })).week;
    await expect(call(answerCheckinQuestion, "q2", { key: q.key, answerId: "hurt", today: TODAY }))
      .rejects.toThrow(/where it hurts/);
    const { noteId } = await call<{ noteId: string }>(answerCheckinQuestion, "q2", {
      key: q.key, answerId: "hurt", today: TODAY, pain: { area: "Knee", level: "Sore", duration: "ongoing", text: "Aches going down" },
    });
    expect((await db.doc(`users/q2/feedbackNotes/${noteId}`).get()).data()).toMatchObject({
      tags: ["pain", "checkin"], text: "Knee, sore. Aches going down", duration: "ongoing",
    });
  });

  it("drops a question answered in an earlier check-in", async () => {
    await seed("q3");
    const [q] = (await call<Questions>(getCheckinQuestions, "q3", { today: TODAY })).week;
    const { noteId } = await call<{ noteId: string }>(answerCheckinQuestion, "q3", { key: q.key, answerId: "once", today: TODAY });
    await db.doc(`users/q3/feedbackNotes/${noteId}`).update({ status: "done" }); // an update used it
    expect((await call<Questions>(getCheckinQuestions, "q3", { today: TODAY })).week).toEqual([]);
    await expect(call(answerCheckinQuestion, "q3", { key: q.key, answerId: "prefer", today: TODAY }))
      .rejects.toThrow(/already gone into a plan update/);
  });

  it("only takes the question's own answers, for questions the app asked", async () => {
    await seed("q4");
    const [q] = (await call<Questions>(getCheckinQuestions, "q4", { today: TODAY })).week;
    await expect(call(answerCheckinQuestion, "q4", { key: q.key, answerId: "made-up", today: TODAY })).rejects.toThrow(/Unknown answer/);
    await expect(call(answerCheckinQuestion, "q4", { key: "skipped|2020-01-01", answerId: "busy", today: TODAY })).rejects.toThrow(/no longer applies/);
  });

  it("limits answers waiting for one update", async () => {
    await seed("q5");
    const [q] = (await call<Questions>(getCheckinQuestions, "q5", { today: TODAY })).week;
    for (let i = 0; i < MAX_PENDING_ANSWERS; i++) {
      await db.collection("users/q5/feedbackNotes").add({ status: "pending", source: "checkin_question", tags: ["checkin"], questionKey: `other|${i}` });
    }
    await expect(call(answerCheckinQuestion, "q5", { key: q.key, answerId: "once", today: TODAY })).rejects.toThrow(/plenty/);
  });

  it("isn't available on a group plan", async () => {
    await seed("q6", { activeProgramSource: "group", groupId: "g1" });
    await expect(call(getCheckinQuestions, "q6", { today: TODAY })).rejects.toThrow(/group plans/);
  });
});
