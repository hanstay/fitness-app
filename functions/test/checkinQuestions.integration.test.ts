// Emulator-backed: the check-in's question callables
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
interface Questions { questions: View[] }

// The athlete's today, so the test doesn't depend on when it runs.
const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const ago = (days: number) => Timestamp.fromMillis(Date.now() - days * 86400000);

const lower = { day: "Monday", label: "Lower", focus_note: null, exercises: [{ name: "Squat (Barbell)", sets: 3, reps: "6-8", rir: "2" }] };

/** A plan read `readDaysAgo` days ago, with Hevy last imported `hevyDaysAgo` days ago. */
async function seed(uid: string, readDaysAgo: number, hevyDaysAgo: number) {
  await db.doc(`users/${uid}`).set({ uid, athlete: { goal: "Get stronger" } });
  const program = db.collection(`users/${uid}/programs`).doc();
  await program.set({ status: "active", inputsReadAt: ago(readDaysAgo), sessions: [lower] });
  await db.doc(`users/${uid}/state/summary`).set({
    activeProgramSource: "personal",
    currentProgramId: program.id,
    integrationsStatus: { hevy: { csvUploaded: true, lastSessionDate: daysAgo(hevyDaysAgo) } },
  });
}

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe("check-in questions", () => {
  it("asks Welcome back, saves the answer as a note for the update, and lets it be changed or taken back", async () => {
    await seed("q1", 30, 1);
    const first = await call<Questions>(getCheckinQuestions, "q1", { today: TODAY });
    expect(first.questions.map((q) => q.kind)).toEqual(["long_gap"]);
    const q = first.questions[0];

    const { noteId } = await call<{ noteId: string }>(answerCheckinQuestion, "q1", { key: q.key, answerId: "injured", text: "Sprained ankle", today: TODAY, tzOffset: -480 });
    expect((await db.doc(`users/q1/feedbackNotes/${noteId}`).get()).data()).toMatchObject({
      status: "pending", source: "checkin_question", tags: ["checkin"], questionKey: q.key, answerId: "injured",
      text: "Sprained ankle", exercise: null, day: null, duration: "week",
      checkin: { question: q.text, answer: "Injured or sick" },
    });

    // The update sees it with the app's guidance.
    const block = formatFeedbackBlock(await loadActiveNotes(db, "q1"));
    expect(block).toContain(`answered "Injured or sick". To do: Back after 4 weeks injured or sick`);

    // Asked again with its answer, and changing it updates the same note.
    const again = await call<Questions>(getCheckinQuestions, "q1", { today: TODAY });
    expect(again.questions[0].answer).toMatchObject({ noteId, answerId: "injured" });
    await call(answerCheckinQuestion, "q1", { key: q.key, answerId: "holiday", today: TODAY });
    const notes = await db.collection("users/q1/feedbackNotes").get();
    expect(notes.docs.map((d) => [d.id, d.get("answerId"), d.get("text")])).toEqual([[noteId, "holiday", ""]]);

    await call(removeFeedbackNote, "q1", { noteId });
    expect((await db.collection("users/q1/feedbackNotes").get()).size).toBe(0);
  });

  it("drops a question answered in an earlier check-in", async () => {
    await seed("q3", 30, 1);
    const [q] = (await call<Questions>(getCheckinQuestions, "q3", { today: TODAY })).questions;
    const { noteId } = await call<{ noteId: string }>(answerCheckinQuestion, "q3", { key: q.key, answerId: "busy", today: TODAY });
    await db.doc(`users/q3/feedbackNotes/${noteId}`).update({ status: "done" }); // an update used it
    expect((await call<Questions>(getCheckinQuestions, "q3", { today: TODAY })).questions).toEqual([]);
    await expect(call(answerCheckinQuestion, "q3", { key: q.key, answerId: "holiday", today: TODAY }))
      .rejects.toThrow(/already gone into a plan update/);
  });

  it("only takes the question's own answers, for questions the app asked", async () => {
    await seed("q4", 30, 1);
    const [q] = (await call<Questions>(getCheckinQuestions, "q4", { today: TODAY })).questions;
    await expect(call(answerCheckinQuestion, "q4", { key: q.key, answerId: "made-up", today: TODAY })).rejects.toThrow(/Unknown answer/);
    await expect(call(answerCheckinQuestion, "q4", { key: q.key, answerId: "import", today: TODAY })).rejects.toThrow(/Unknown answer/);
    await expect(call(answerCheckinQuestion, "q4", { key: "no_new_data|2020-01-01", answerId: "rest", today: TODAY })).rejects.toThrow(/no longer applies/);
  });

  it("asks about missing Hevy data, trusting the stored workouts over a stale import status", async () => {
    await seed("q5", 6, 20);
    expect((await call<Questions>(getCheckinQuestions, "q5", { today: TODAY })).questions.map((q) => q.kind)).toEqual(["no_new_data"]);
    // A workout stored since, though the import status never said so.
    const day = daysAgo(2);
    await db.doc("users/q5/strengthSessions/s1").set({
      date: day, title: "Lower", start_time: `${day} 07:00`, end_time: `${day} 08:00`, source: "hevy", exercises: [],
    });
    expect((await call<Questions>(getCheckinQuestions, "q5", { today: TODAY })).questions).toEqual([]);
  });

  it("limits answers waiting for one update", async () => {
    await seed("q6", 30, 1);
    const [q] = (await call<Questions>(getCheckinQuestions, "q6", { today: TODAY })).questions;
    for (let i = 0; i < MAX_PENDING_ANSWERS; i++) {
      await db.collection("users/q6/feedbackNotes").add({ status: "pending", source: "checkin_question", tags: ["checkin"], questionKey: `other|${i}` });
    }
    await expect(call(answerCheckinQuestion, "q6", { key: q.key, answerId: "busy", today: TODAY })).rejects.toThrow(/plenty/);
  });

  it("reads a group member's gap from their own layer, or its write time when it has no read time", async () => {
    await db.doc("users/q7").set({ uid: "q7", athlete: { goal: "Get stronger" } });
    await db.doc("groups/g7").set({ memberUids: ["q7"], fixedSessions: [] });
    await db.doc("groups/g7/programs/p1").set({ status: "active", createdAt: ago(56), sessions: [lower] });
    await db.doc("users/q7/state/summary").set({
      activeProgramSource: "group", groupId: "g7",
      integrationsStatus: { hevy: { csvUploaded: true, lastSessionDate: daysAgo(1) } },
    });
    // Written by a backend from before inputsReadAt.
    await db.doc("groups/g7/members/q7").set({ groupProgramId: "p1", updatedAt: ago(6) });
    expect((await call<Questions>(getCheckinQuestions, "q7", { today: TODAY })).questions).toEqual([]);
    await db.doc("groups/g7/members/q7").set({ groupProgramId: "p1", inputsReadAt: ago(30) });
    expect((await call<Questions>(getCheckinQuestions, "q7", { today: TODAY })).questions.map((q) => q.kind)).toEqual(["long_gap"]);
  });
});
