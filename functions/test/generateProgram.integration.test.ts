// Emulator-backed: the personal (non-group) path of runGenerateProgram —
// full-vs-incremental branching and mergeIncrementalSessions — with only the
// LLM boundary mocked. See functions/test/README.md for how to run this.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
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
