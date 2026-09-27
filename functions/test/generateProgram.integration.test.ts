// Emulator-backed: the personal (non-group) path of runGenerateProgram —
// full-vs-incremental branching and mergeIncrementalSessions — with only the
// LLM boundary mocked. See functions/test/README.md for how to run this.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { defaultFixtureResponse } from "./fixtures/llmFixtures";
import { runGenerateProgram } from "../src/generate/generateProgram";

const mockExtractStructuredJson = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/claude", () => ({
  extractStructuredJson: mockExtractStructuredJson,
  MODEL: "claude-sonnet-4-5-20250929",
}));

const db = getTestDb();

function baseAthlete(overrides: Record<string, unknown> = {}) {
  return {
    goal: "Get stronger", training_days_per_week: 4, session_length_minutes: 60,
    preferred_split: null, equipment: ["barbell"], events: [], fixed_sessions: [],
    injuries_constraints: "", current_lifts: [],
    ...overrides,
  };
}

async function seedUser(uid: string, athleteOverrides: Record<string, unknown> = {}) {
  await db.doc(`users/${uid}`).set({ uid, athlete: baseAthlete(athleteOverrides) });
  await db.doc(`users/${uid}/state/summary`).set({ currentProgramId: null, activeProgramSource: "personal" });
}

function toolNamesCalled(): string[] {
  return mockExtractStructuredJson.mock.calls.map((call) => (call[0] as { toolName: string }).toolName);
}

beforeEach(async () => {
  await clearFirestoreEmulator();
  mockExtractStructuredJson.mockReset();
  mockExtractStructuredJson.mockImplementation(defaultFixtureResponse);
});

describe("personal program generation", () => {
  it("scenario 1: first-ever generation runs the full path", async () => {
    await seedUser("u1");

    const result = await runGenerateProgram("u1");

    expect(toolNamesCalled()).toEqual(expect.arrayContaining(["record_program_overview", "record_program_schedule"]));
    expect(toolNamesCalled()).not.toContain("record_program_update");

    const activeSnap = await db.collection("users/u1/programs").where("status", "==", "active").get();
    expect(activeSnap.size).toBe(1);
    expect(result.programId).toBe(activeSnap.docs[0].id);

    const summary = await db.doc("users/u1/state/summary").get();
    expect(summary.data()?.currentProgramId).toBe(activeSnap.docs[0].id);
  });

  it("scenario 2: routine check-in with no structural change runs only the incremental update, carrying forward untouched sessions", async () => {
    await seedUser("u2");
    const athlete = baseAthlete();
    await db.collection("users/u2/programs").add({
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      title: "Existing plan", goalSummary: "x", split: "Upper/Lower", daysPerWeek: 4,
      events: [], roadmap: [], progressionRules: "x", deloadGuidance: "x", warmupNotes: "x",
      coachNotes: null, sportNotes: null, nutritionNote: null, running: null,
      currentState: null,
      weeklyStructure: [{ day: "Monday", focus: "Upper", note: null }, { day: "Tuesday", focus: "Lower", note: null }],
      sessions: [
        { day: "Monday", label: "Upper (old)", focus_note: null, exercises: [{ name: "Old Bench", sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null }] },
        { day: "Tuesday", label: "Lower (old)", focus_note: null, exercises: [{ name: "Old Squat", sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null }] },
      ],
      profileSnapshot: athlete,
    });

    await runGenerateProgram("u2");

    expect(toolNamesCalled()).toEqual(["record_program_update"]);

    const activeSnap = await db.collection("users/u2/programs").where("status", "==", "active").get();
    expect(activeSnap.size).toBe(1);
    const sessions = activeSnap.docs[0].data().sessions as Array<{ day: string; label: string }>;
    // Monday replaced by the fixture's update, Tuesday carried forward untouched.
    expect(sessions.find((s) => s.day === "Monday")?.label).not.toBe("Upper (old)");
    expect(sessions.find((s) => s.day === "Tuesday")?.label).toBe("Lower (old)");
  });

  it("scenario 3: a structural profile change forces the full path even with an existing program", async () => {
    await seedUser("u3", { training_days_per_week: 5 }); // differs from the seeded snapshot's 4
    await db.collection("users/u3/programs").add({
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      title: "Existing plan", goalSummary: "x", split: "Upper/Lower", daysPerWeek: 4,
      events: [], roadmap: [], progressionRules: "x", deloadGuidance: "x", warmupNotes: "x",
      coachNotes: null, sportNotes: null, nutritionNote: null, running: null,
      currentState: null, weeklyStructure: [], sessions: [],
      profileSnapshot: baseAthlete({ training_days_per_week: 4 }),
    });

    await runGenerateProgram("u3");

    expect(toolNamesCalled()).toEqual(expect.arrayContaining(["record_program_overview", "record_program_schedule"]));
  });
});

describe("phase transitions", () => {
  const DAY = 86400000;
  const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
  const phase = (name: string, start: number | null, end: number | null) => ({
    phase: name, dates: name, startDate: start == null ? null : iso(start), endDate: end == null ? null : iso(end),
    focus: `${name} focus`, lifting: `${name} lifting`, running: null, nutrition: null,
  });
  // Today falls in Base; Build starts in 5 days; Peak after that.
  const datedRoadmap = [phase("Base", -30, 4), phase("Build", 5, 40), phase("Peak", 41, 60)];

  async function seedProgram(uid: string, fields: Record<string, unknown>) {
    return db.collection(`users/${uid}/programs`).add({
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      title: "Existing plan", goalSummary: "x", split: "Upper/Lower", daysPerWeek: 4,
      events: [], progressionRules: "x", deloadGuidance: "x", warmupNotes: "x",
      coachNotes: null, sportNotes: null, nutritionNote: null, running: null, currentState: null,
      weeklyStructure: [{ day: "Monday", focus: "Upper", note: null }],
      sessions: [{ day: "Monday", label: "Upper", focus_note: null, exercises: [{ name: "Bench Press (Barbell)", sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null }] }],
      profileSnapshot: baseAthlete(),
      ...fields,
    });
  }

  async function activeProgram(uid: string) {
    const snap = await db.collection(`users/${uid}/programs`).where("status", "==", "active").get();
    expect(snap.size).toBe(1);
    return snap.docs[0].data();
  }

  it("'move to the next phase' keeps the roadmap, re-dates the switch to today, and programs the next phase", async () => {
    await seedUser("p1");
    await seedProgram("p1", { roadmap: datedRoadmap, currentPhaseIndex: 0, blockStartedAt: Timestamp.fromMillis(Date.now() - 25 * DAY) });

    const result = await runGenerateProgram("p1", { force: true });

    expect(toolNamesCalled()).toEqual(expect.arrayContaining(["record_program_overview", "record_program_schedule"]));
    const overviewCall = mockExtractStructuredJson.mock.calls.find((c) => c[0].toolName === "record_program_overview")!;
    expect(overviewCall[0].userText).toContain("MOVING TO ITS NEXT PHASE");
    expect(overviewCall[0].userText).toContain(`Phase to program now: "Build"`);

    const p = await activeProgram("p1");
    expect(p.roadmap.map((r: { phase: string }) => r.phase)).toEqual(["Base", "Build", "Peak"]); // not the fixture's roadmap
    expect(p.roadmap[0].endDate).toBe(iso(-1));
    expect(p.roadmap[1].startDate).toBe(iso(0));
    expect(p.roadmap[2]).toMatchObject({ startDate: datedRoadmap[2].startDate, endDate: datedRoadmap[2].endDate });
    expect(p.currentPhaseIndex).toBe(1);
    expect(p.blockStartedAt.toMillis()).toBeGreaterThan(Date.now() - 60000);
    expect(result.changeSummary?.[0]).toContain("Base → Build");
  });

  it("a weekly update keeps the block's start date and phase instead of resetting them", async () => {
    await seedUser("p2");
    const started = Timestamp.fromMillis(Date.now() - 20 * DAY);
    await seedProgram("p2", { roadmap: datedRoadmap, currentPhaseIndex: 0, blockStartedAt: started });

    await runGenerateProgram("p2");

    expect(toolNamesCalled()).toEqual(["record_program_update"]);
    const p = await activeProgram("p2");
    expect(p.blockStartedAt.toMillis()).toBe(started.toMillis());
    expect(p.currentPhaseIndex).toBe(0);
    expect(p.roadmap).toEqual(datedRoadmap);
  });

  it("an older undated plan updated weekly still moves to its next phase after 6 weeks", async () => {
    await seedUser("p3");
    const undated = [phase("Base", null, null), phase("Build", null, null)];
    // The block's original generation 7 weeks ago, then weekly updates since — each with its own createdAt.
    await seedProgram("p3", { status: "archived", roadmap: undated, createdAt: Timestamp.fromMillis(Date.now() - 49 * DAY) });
    await seedProgram("p3", { status: "archived", roadmap: undated, createdAt: Timestamp.fromMillis(Date.now() - 9 * DAY) });
    await seedProgram("p3", { roadmap: undated, createdAt: Timestamp.fromMillis(Date.now() - 2 * DAY) });

    await runGenerateProgram("p3");

    expect(toolNamesCalled()).toEqual(expect.arrayContaining(["record_program_overview", "record_program_schedule"]));
    const p = await activeProgram("p3");
    expect(p.roadmap.map((r: { phase: string }) => r.phase)).toEqual(["Base", "Build"]);
    expect(p.currentPhaseIndex).toBe(1);
  });

  it("an older undated plan updated weekly within 6 weeks stays a weekly update (and is still valid)", async () => {
    await seedUser("p4");
    const legacy = [{ phase: "Base", dates: "Weeks 1-6", focus: "f", lifting: "l", running: null, nutrition: null }]; // no startDate/endDate keys at all
    const created = Timestamp.fromMillis(Date.now() - 10 * DAY);
    await seedProgram("p4", { roadmap: legacy, createdAt: created });

    await runGenerateProgram("p4");

    expect(toolNamesCalled()).toEqual(["record_program_update"]);
    const p = await activeProgram("p4");
    expect(p.currentPhaseIndex).toBe(0);
    expect(p.blockStartedAt.toMillis()).toBe(created.toMillis()); // recovered from history, then kept
    expect(p.roadmap[0]).toMatchObject({ phase: "Base", startDate: null, endDate: null });
  });
});
