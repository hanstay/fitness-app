// Emulator-backed: the Program page's "Move day" callable
// (feedback/moveDay.ts) on a personal and a group plan. See
// functions/test/README.md for how to run this.
import { describe, it, expect, beforeEach } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { moveProgramDay } from "../src/feedback/moveDay";

const db = getTestDb();

type Callable = { run: (req: unknown) => Promise<unknown> };
const call = (uid: string, data: unknown) => (moveProgramDay as unknown as Callable).run({ auth: { uid }, data });

const ex = (name: string) => ({ name, sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null });
const week = () => ({
  weeklyStructure: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => ({
    day, focus: day === "Monday" ? "Lower" : day === "Thursday" ? "Upper" : "Rest", note: null,
  })),
  sessions: [
    { day: "Monday", label: "Lower", focus_note: null, exercises: [ex("Squat (Barbell)")] },
    { day: "Thursday", label: "Upper", focus_note: null, exercises: [ex("Bench Press (Barbell)")] },
  ],
});
const days = (sessions: Array<{ day: string }>) => sessions.map((s) => s.day);

async function seedPersonal(uid: string, { athlete = {}, summary = {} }: { athlete?: object; summary?: object } = {}) {
  const ref = db.collection(`users/${uid}/programs`).doc();
  await ref.set({
    status: "active",
    ...week(),
    swaps: [{ id: "s1", day: "Monday", sessionIndex: 0, exerciseIndex: 0, from: ex("Leg Press (Machine)"), to: ex("Squat (Barbell)") }],
  });
  await db.doc(`users/${uid}`).set({ uid, athlete });
  await db.doc(`users/${uid}/state/summary`).set({ activeProgramSource: "personal", currentProgramId: ref.id, ...summary });
  return ref;
}

async function seedGroup() {
  await db.doc("groups/g1").set({ leaderUid: "lead", memberUids: ["lead", "mem"], fixedSessions: [{ day: "Sat", activity: "Hyrox class" }] });
  const ref = db.collection("groups/g1/programs").doc();
  await ref.set({ status: "active", ...week() });
  for (const uid of ["lead", "mem"]) {
    await db.doc(`users/${uid}/state/summary`).set({ activeProgramSource: "group", groupId: "g1" });
    await db.doc(`groups/g1/members/${uid}`).set({
      groupProgramId: ref.id,
      sessionLoads: [
        { day: "Monday", exercises: [{ name: "Squat (Barbell)", load_note: `${uid} squat` }] },
        { day: "Thursday", exercises: [{ name: "Bench Press (Barbell)", load_note: `${uid} bench` }] },
      ],
    });
  }
  return ref;
}

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe("moveProgramDay on a personal plan", () => {
  it("moves the day's sessions, swaps and waiting notes", async () => {
    const ref = await seedPersonal("p1");
    const waiting = await db.collection("users/p1/feedbackNotes").add({ status: "pending", day: "Monday", exercise: "Squat (Barbell)" });
    const used = await db.collection("users/p1/feedbackNotes").add({ status: "open", day: "Monday", exercise: "Squat (Barbell)" });

    await call("p1", { programId: ref.id, from: "Monday", to: "Wednesday" });

    const program = (await ref.get()).data()!;
    expect(days(program.sessions)).toEqual(["Wednesday", "Thursday"]);
    expect(program.weeklyStructure.map((d: { focus: string }) => d.focus)).toEqual(["Rest", "Rest", "Lower", "Upper", "Rest", "Rest", "Rest"]);
    expect(program.swaps[0].day).toBe("Wednesday");
    expect(program.weekEditedAt).toBeInstanceOf(Timestamp);
    expect((await waiting.get()).get("day")).toBe("Wednesday");
    expect((await used.get()).get("day")).toBe("Monday");
  });

  it("refuses a plan that isn't current, one being updated, and a fixed session's day", async () => {
    const ref = await seedPersonal("p2", { summary: { currentProgramId: "other" } });
    await expect(call("p2", { programId: ref.id, from: "Monday", to: "Tuesday" })).rejects.toMatchObject({ code: "failed-precondition" });

    const updating = await seedPersonal("p3", { summary: { programGenerationStatus: "generating", programGenerationStartedAt: Timestamp.now() } });
    await expect(call("p3", { programId: updating.id, from: "Monday", to: "Tuesday" })).rejects.toMatchObject({ code: "failed-precondition" });

    const fixed = await seedPersonal("p4", { athlete: { fixed_sessions: [{ day: "Tuesday", activity: "Spin class" }] } });
    await expect(call("p4", { programId: fixed.id, from: "Monday", to: "Tuesday" })).rejects.toMatchObject({
      code: "failed-precondition", message: expect.stringContaining("Spin class"),
    });
    expect(days((await fixed.get()).get("sessions"))).toEqual(["Monday", "Thursday"]);
  });

  it("rejects bad days", async () => {
    const ref = await seedPersonal("p5");
    await expect(call("p5", { programId: ref.id, from: "Monday", to: "Monday" })).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(call("p5", { programId: ref.id, from: "Mon", to: "Friday" })).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(moveProgramDay.run({ data: { programId: ref.id, from: "Monday", to: "Friday" } } as never)).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("moveProgramDay on a group plan", () => {
  it("lets the leader move the shared week, with every member's loads and notes", async () => {
    const ref = await seedGroup();
    const note = await db.collection("users/mem/feedbackNotes").add({ status: "pending", day: "Thursday", exercise: "Bench Press (Barbell)" });

    await call("lead", { programId: ref.id, from: "Thursday", to: "Friday" });

    expect(days((await ref.get()).get("sessions"))).toEqual(["Monday", "Friday"]);
    for (const uid of ["lead", "mem"]) {
      const loads = (await db.doc(`groups/g1/members/${uid}`).get()).get("sessionLoads");
      expect(loads.map((l: { day: string }) => l.day)).toEqual(["Monday", "Friday"]);
    }
    expect((await note.get()).get("day")).toBe("Friday");
  });

  it("refuses a member who isn't the leader, a fixed session's day, and a member's running update", async () => {
    const ref = await seedGroup();
    await expect(call("mem", { programId: ref.id, from: "Monday", to: "Tuesday" })).rejects.toMatchObject({ code: "permission-denied" });
    await expect(call("lead", { programId: ref.id, from: "Monday", to: "Saturday" })).rejects.toMatchObject({
      code: "failed-precondition", message: expect.stringContaining("Hyrox class"),
    });
    await db.doc("users/mem/state/summary").set({ programGenerationStatus: "generating", programGenerationStartedAt: Timestamp.now() }, { merge: true });
    await expect(call("lead", { programId: ref.id, from: "Monday", to: "Tuesday" })).rejects.toMatchObject({ code: "failed-precondition" });
    expect(days((await ref.get()).get("sessions"))).toEqual(["Monday", "Thursday"]);
  });

  it("leaves a member who follows their own plan alone", async () => {
    const ref = await seedGroup();
    await db.doc("users/mem/state/summary").set({ activeProgramSource: "personal", programGenerationStatus: "generating", programGenerationStartedAt: Timestamp.now() });
    const note = await db.collection("users/mem/feedbackNotes").add({ status: "pending", day: "Monday", exercise: "Squat (Barbell)" });
    await call("lead", { programId: ref.id, from: "Monday", to: "Tuesday" });
    expect(days((await ref.get()).get("sessions"))).toEqual(["Tuesday", "Thursday"]);
    expect((await note.get()).get("day")).toBe("Monday");
  });

  it("leaves a member's loads written for an earlier shared week alone", async () => {
    const ref = await seedGroup();
    await db.doc("groups/g1/members/mem").update({ groupProgramId: "older" });
    await call("lead", { programId: ref.id, from: "Monday", to: "Tuesday" });
    const loads = (await db.doc("groups/g1/members/mem").get()).get("sessionLoads");
    expect(loads.map((l: { day: string }) => l.day)).toEqual(["Monday", "Thursday"]);
  });
});
