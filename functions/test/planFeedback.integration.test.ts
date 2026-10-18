// Emulator-backed: the check-in note callables and the Program page's swap
// callables (feedback/), with only the LLM boundary mocked. See
// functions/test/README.md for how to run this.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { addFeedbackNote, removeFeedbackNote, updateFeedbackNoteGroup, followUpFeedbackNote } from "../src/feedback/feedbackNotes";
import { suggestExerciseSwaps, applyExerciseSwap, undoExerciseSwap, SWAP_SUGGESTIONS_PER_DAY } from "../src/feedback/exerciseSwap";
import { MAX_PENDING_NOTES, MAX_ACTIVE_NOTES } from "../src/lib/planFeedback";

const mockExtractStructuredJson = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/claude", () => ({
  extractStructuredJson: mockExtractStructuredJson,
  MODEL: "claude-sonnet-5-5",
  FAST_MODEL: "claude-haiku-5-5",
}));

const db = getTestDb();

type Callable = { run: (req: unknown) => Promise<unknown> };
const call = <T = Record<string, unknown>>(fn: Callable, uid: string, data: unknown) =>
  fn.run({ auth: { uid }, data }) as Promise<T>;

const ex = (name: string) => ({ name, sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null });
const option = (name: string) => ({ name, why: "Same pattern", sets: 3, reps: "10", rir: "2", rest_seconds: 60, load_note: null });

async function seedUser(uid: string, summary: Record<string, unknown> = {}) {
  await db.doc(`users/${uid}`).set({ uid, athlete: { goal: "Get stronger", equipment: ["dumbbells"] } });
  await db.doc(`users/${uid}/state/summary`).set({ activeProgramSource: "personal", ...summary });
}

async function seedProgram(uid: string): Promise<string> {
  const ref = db.collection(`users/${uid}/programs`).doc();
  await ref.set({
    status: "active",
    sessions: [
      { day: "Monday", label: "Lower", focus_note: null, exercises: [ex("Squat (Barbell)"), ex("Walking Lunge (Dumbbell)")] },
    ],
  });
  await db.doc(`users/${uid}/state/summary`).set({ currentProgramId: ref.id }, { merge: true });
  return ref.id;
}

const noteDocs = async (uid: string) => (await db.collection(`users/${uid}/feedbackNotes`).get()).docs;

beforeEach(async () => {
  await clearFirestoreEmulator();
  mockExtractStructuredJson.mockReset();
});

describe("check-in notes", () => {
  it("saves a note as pending, and takes it back", async () => {
    await seedUser("n1");
    const { noteId } = await call<{ noteId: string }>(addFeedbackNote, "n1", { tags: ["pain"], text: "Knee on lunges", exercise: "Walking Lunge (Dumbbell)", day: "mon", duration: "ongoing" });
    const saved = (await db.doc(`users/n1/feedbackNotes/${noteId}`).get()).data();
    expect(saved).toMatchObject({ tags: ["pain"], day: "Monday", duration: "ongoing", status: "pending", source: "checkin" });

    await call(removeFeedbackNote, "n1", { noteId });
    expect(await noteDocs("n1")).toHaveLength(0);
  });

  it("rejects a bad note and more than the pending limit", async () => {
    await seedUser("n2");
    await expect(call(addFeedbackNote, "n2", { tags: [], text: "x" })).rejects.toMatchObject({ code: "invalid-argument" });
    for (let i = 0; i < MAX_PENDING_NOTES; i++) await db.collection("users/n2/feedbackNotes").add({ status: "pending" });
    await expect(call(addFeedbackNote, "n2", { tags: ["dislike"], text: "x" })).rejects.toMatchObject({ code: "resource-exhausted" });

    // Check-in answers don't use up the notes' limit.
    await seedUser("n7");
    for (let i = 0; i < MAX_PENDING_NOTES; i++) await db.collection("users/n7/feedbackNotes").add({ status: "pending", source: "checkin_question" });
    await expect(call(addFeedbackNote, "n7", { tags: ["dislike"], text: "x" })).resolves.toHaveProperty("noteId");

    await seedUser("n6");
    for (let i = 0; i < MAX_ACTIVE_NOTES; i++) await db.collection("users/n6/feedbackNotes").add({ status: "open" });
    await expect(call(addFeedbackNote, "n6", { tags: ["dislike"], text: "x" })).rejects.toMatchObject({ code: "resource-exhausted" });


    // A group member's own update works around their notes (groupProgram.ts).
    await seedUser("n3", { activeProgramSource: "group", groupId: "g1" });
    await expect(call(addFeedbackNote, "n3", { tags: ["dislike"], text: "x" })).resolves.toHaveProperty("noteId");
  });

  it("saves a card with several exercises as one group, edits it and removes it", async () => {
    await seedUser("g1");
    const saved = await call<{ noteIds: string[]; groupId: string }>(addFeedbackNote, "g1", {
      tags: ["pain"], text: "Knee", duration: "ongoing",
      exercises: [{ exercise: "Squat (Barbell)", day: "Monday" }, { exercise: "Walking Lunge (Dumbbell)", day: "Monday" }],
    });
    expect(saved.noteIds).toHaveLength(2);
    const byExercise = async () => Object.fromEntries((await noteDocs("g1")).map((d) => [d.get("exercise"), { id: d.id, ...d.data() }]));
    let notes = await byExercise();
    expect(Object.values(notes).every((n) => (n as { groupId?: string }).groupId === saved.groupId)).toBe(true);
    const squatId = (notes["Squat (Barbell)"] as { id: string }).id;

    // Untick the lunge, add the step-up, and change the text.
    await call(updateFeedbackNoteGroup, "g1", {
      groupId: saved.groupId, tags: ["pain", "too_hard"], text: "Knee, worse going down", duration: "week",
      exercises: [{ exercise: "Squat (Barbell)", day: "Monday" }, { exercise: "Box Step-Up (Dumbbell)", day: "Monday" }],
    });
    notes = await byExercise();
    expect(Object.keys(notes).sort()).toEqual(["Box Step-Up (Dumbbell)", "Squat (Barbell)"]);
    expect(notes["Squat (Barbell)"]).toMatchObject({ id: squatId, tags: ["pain", "too_hard"], text: "Knee, worse going down", duration: "week", status: "pending" });
    expect(notes["Box Step-Up (Dumbbell)"]).toMatchObject({ groupId: saved.groupId, status: "pending", source: "checkin" });

    await call(removeFeedbackNote, "g1", { groupId: saved.groupId });
    expect(await noteDocs("g1")).toHaveLength(0);
  });

  it("refuses a card past the limit, and editing a group an update has used", async () => {
    await seedUser("g2");
    for (let i = 0; i < MAX_PENDING_NOTES - 1; i++) await db.collection("users/g2/feedbackNotes").add({ status: "pending" });
    const two = [{ exercise: "Squat (Barbell)" }, { exercise: "Walking Lunge (Dumbbell)" }];
    await expect(call(addFeedbackNote, "g2", { tags: ["dislike"], text: "x", exercises: two })).rejects.toMatchObject({ code: "resource-exhausted" });
    expect(await noteDocs("g2")).toHaveLength(MAX_PENDING_NOTES - 1); // nothing half saved

    await db.doc("users/g2/feedbackNotes/used").set({ status: "open", groupId: "grp", exercise: "Squat (Barbell)", day: null });
    await expect(call(updateFeedbackNoteGroup, "g2", { groupId: "grp", tags: ["dislike"], text: "x" })).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(call(removeFeedbackNote, "g2", { groupId: "grp" })).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(call(removeFeedbackNote, "g2", { groupId: "../x" })).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("won't take back a note an update has used", async () => {
    await seedUser("n4");
    await db.doc("users/n4/feedbackNotes/a").set({ status: "open" });
    await expect(call(removeFeedbackNote, "n4", { noteId: "a" })).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("records a follow-up only on an open note", async () => {
    await seedUser("n5");
    await db.doc("users/n5/feedbackNotes/a").set({ status: "open", worse: false });
    await call(followUpFeedbackNote, "n5", { noteId: "a", outcome: "better" });
    expect((await db.doc("users/n5/feedbackNotes/a").get()).data()).toMatchObject({ status: "resolved", announced: false });
    await expect(call(followUpFeedbackNote, "n5", { noteId: "a", outcome: "worse" })).rejects.toMatchObject({ code: "failed-precondition" });
  });
});

describe("exercise swaps", () => {
  it("suggests alternatives the day doesn't already have, with the fast model", async () => {
    await seedUser("s1");
    const programId = await seedProgram("s1");
    mockExtractStructuredJson.mockResolvedValue({ options: [option("Squat (Barbell)"), option("Box Step-Up (Dumbbell)"), option("Split Squat (Dumbbell)")] });

    const { options } = await call<{ options: Array<{ name: string }> }>(suggestExerciseSwaps, "s1", { programId, sessionIndex: 0, exerciseIndex: 1, reason: "hurts" });

    expect(options.map((o) => o.name)).toEqual(["Box Step-Up (Dumbbell)", "Split Squat (Dumbbell)"]);
    const params = mockExtractStructuredJson.mock.calls[0][0] as { model: string; userText: string };
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.userText).toContain("Reason: it hurts");
  });

  it("stops suggesting after the daily allowance", async () => {
    await seedUser("s2");
    const programId = await seedProgram("s2");
    await db.doc("users/s2/state/usage").set({ swapSuggestions: { day: new Date().toISOString().slice(0, 10), count: SWAP_SUGGESTIONS_PER_DAY } });
    await expect(call(suggestExerciseSwaps, "s2", { programId, sessionIndex: 0, exerciseIndex: 1, reason: "dislike" }))
      .rejects.toMatchObject({ code: "resource-exhausted" });
    expect(mockExtractStructuredJson).not.toHaveBeenCalled();
  });

  it("doesn't count a failed suggestion against the day's allowance", async () => {
    await seedUser("s5");
    const programId = await seedProgram("s5");
    mockExtractStructuredJson.mockRejectedValue(new Error("model down"));
    await expect(call(suggestExerciseSwaps, "s5", { programId, sessionIndex: 0, exerciseIndex: 1, reason: "dislike" }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect((await db.doc("users/s5/state/usage").get()).get("swapSuggestions.count")).toBe(0);
  });

  it("keeps one pain note when an exercise swapped in for pain is swapped again", async () => {
    await seedUser("s6");
    const programId = await seedProgram("s6");
    const base = { programId, sessionIndex: 0, exerciseIndex: 1, reason: "hurts", scope: "this_week" };
    await call(applyExerciseSwap, "s6", { ...base, expectedName: "Walking Lunge (Dumbbell)", option: option("Box Step-Up (Dumbbell)") });
    const { swap } = await call<{ swap: { noteId: string; from: { name: string } } }>(applyExerciseSwap, "s6",
      { ...base, expectedName: "Box Step-Up (Dumbbell)", option: option("Split Squat (Dumbbell)") });
    expect(await noteDocs("s6")).toHaveLength(1);
    expect(swap.noteId).toBe((await noteDocs("s6"))[0].id);
    expect(swap.from.name).toBe("Walking Lunge (Dumbbell)");
  });

  it("swaps an exercise for pain with a linked note, and undo puts both back", async () => {
    await seedUser("s3");
    const programId = await seedProgram("s3");
    const { swap } = await call<{ swap: { id: string; noteId: string } }>(applyExerciseSwap, "s3", {
      programId, sessionIndex: 0, exerciseIndex: 1, expectedName: "Walking Lunge (Dumbbell)",
      option: option("Box Step-Up (Dumbbell)"), reason: "hurts", scope: "this_week",
    });

    let program = (await db.doc(`users/s3/programs/${programId}`).get()).data()!;
    expect(program.sessions[0].exercises[1].name).toBe("Box Step-Up (Dumbbell)");
    expect(program.swaps).toHaveLength(1);
    const note = (await db.doc(`users/s3/feedbackNotes/${swap.noteId}`).get()).data();
    expect(note).toMatchObject({ tags: ["pain"], exercise: "Walking Lunge (Dumbbell)", day: "Monday", duration: "ongoing", status: "pending", source: "swap" });

    await call(undoExerciseSwap, "s3", { programId, swapId: swap.id });
    program = (await db.doc(`users/s3/programs/${programId}`).get()).data()!;
    expect(program.sessions[0].exercises[1].name).toBe("Walking Lunge (Dumbbell)");
    expect(program.swaps).toEqual([]);
    expect(await noteDocs("s3")).toHaveLength(0);
  });

  it("refuses a swap on a plan that changed or is being updated", async () => {
    await seedUser("s4");
    const programId = await seedProgram("s4");
    const req = { programId, sessionIndex: 0, exerciseIndex: 1, expectedName: "Squat (Barbell)", option: option("Leg Press (Machine)"), reason: "dislike", scope: "this_week" };
    await expect(call(applyExerciseSwap, "s4", req)).rejects.toMatchObject({ code: "failed-precondition" });

    await db.doc("users/s4/state/summary").update({ programGenerationStatus: "generating", programGenerationStartedAt: Timestamp.now() });
    await expect(call(applyExerciseSwap, "s4", { ...req, expectedName: "Walking Lunge (Dumbbell)" }))
      .rejects.toMatchObject({ message: expect.stringContaining("being updated") });
  });
});
