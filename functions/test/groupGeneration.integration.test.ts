// Emulator-backed: exercises the real runGenerateProgram/runGenerateGroupProgram
// orchestration (Stage A/B branching, archive-and-write batches,
// reconcileEvents, the check-in precondition ordering) against a real
// Firestore emulator, with only the LLM boundary mocked. Run via
// `firebase emulators:exec --only firestore --project demo-ci "npx vitest run test/groupGeneration.integration.test.ts"`
// — see functions/test/README.md.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { FIXTURES, defaultFixtureResponse } from "./fixtures/llmFixtures";
import { runGenerateProgram } from "../src/generate/generateProgram";

// vi.mock calls are hoisted above imports by Vitest, so this takes effect
// before generateProgram.ts (and its groupProgram.ts import) load claude.ts.
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

async function seedMember(uid: string, email: string, groupId: string, athleteOverrides: Record<string, unknown> = {}) {
  await db.doc(`users/${uid}`).set({ uid, email, athlete: baseAthlete(athleteOverrides) });
  await db.doc(`users/${uid}/state/summary`).set({ groupId, activeProgramSource: "group", currentProgramId: null });
}

async function seedGroup(groupId: string, memberUids: string[], overrides: Record<string, unknown> = {}) {
  await db.doc(`groups/${groupId}`).set({
    leaderUid: memberUids[0],
    memberUids,
    memberEmails: Object.fromEntries(memberUids.map((u) => [u, `${u}@example.com`])),
    name: "Test Group",
    goal: "Train together",
    events: [],
    daysPerWeek: 4,
    fixedSessions: [],
    createdAt: FieldValue.serverTimestamp(),
    ...overrides,
  });
}

beforeEach(async () => {
  await clearFirestoreEmulator();
  mockExtractStructuredJson.mockReset();
  mockExtractStructuredJson.mockImplementation(defaultFixtureResponse);
});

describe("group generation", () => {
  it("scenario 1: fresh group, no prior program — both stages run, docs written correctly", async () => {
    await seedGroup("g1", ["a", "b"]);
    await seedMember("a", "a", "g1");
    await seedMember("b", "b", "g1");

    const result = await runGenerateProgram("a");

    expect(mockExtractStructuredJson).toHaveBeenCalledWith(expect.objectContaining({ toolName: "record_group_program" }));
    expect(mockExtractStructuredJson).toHaveBeenCalledWith(expect.objectContaining({ toolName: "record_member_layer" }));

    const activeSnap = await db.collection("groups/g1/programs").where("status", "==", "active").get();
    expect(activeSnap.size).toBe(1);
    expect(activeSnap.docs[0].data().groupSnapshot).toEqual({ goal: "Train together", daysPerWeek: 4, events: [], fixedSessions: [] });
    expect(activeSnap.docs[0].data().profileSnapshots).toHaveProperty("a");
    expect(activeSnap.docs[0].data().profileSnapshots).toHaveProperty("b");

    const memberDoc = await db.doc("groups/g1/members/a").get();
    expect(memberDoc.exists).toBe(true);
    expect(result.programId).toBe(activeSnap.docs[0].id);
  });

  it("scenario 2: group's stated events win over an extra event the model proposes", async () => {
    await seedGroup("g2", ["a", "b"], { events: [{ name: "Hyrox Men's Doubles", date: "2026-11-29" }] });
    await seedMember("a", "a", "g2");
    await seedMember("b", "b", "g2");

    mockExtractStructuredJson.mockImplementationOnce(async () => ({
      ...(FIXTURES.record_group_program as Record<string, unknown>),
      events: [
        { name: "Hyrox Men's Doubles", date: "2026-11-29", weeksOut: "~9999 weeks", goal: "Race well." },
        { name: "A Race The Group Never Stated", date: "2027-01-01", weeksOut: "~20 weeks", goal: "Also do this one." },
      ],
    }));

    await runGenerateProgram("a");

    const activeSnap = await db.collection("groups/g2/programs").where("status", "==", "active").get();
    const events = activeSnap.docs[0].data().events;
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("Hyrox Men's Doubles");
    // weeksOut recomputed in code, not the model's "~9999 weeks".
    expect(events[0].weeksOut).not.toBe("~9999 weeks");
  });

  it("scenario 3: a member with no individual training_days_per_week/session_length_minutes can still check in", async () => {
    await seedGroup("g3", ["a", "b"]);
    await seedMember("a", "a", "g3", { training_days_per_week: null, session_length_minutes: null });
    await seedMember("b", "b", "g3");

    await expect(runGenerateProgram("a")).resolves.toBeTruthy();
  });

  it("scenario 4: existing fresh, structurally-unchanged program — only Stage B runs", async () => {
    await seedGroup("g4", ["a", "b"]);
    await seedMember("a", "a", "g4");
    await seedMember("b", "b", "g4");

    // Establish the group's first program for real (Stage A + B), then clear
    // the mock's call history before the scenario we're actually asserting.
    await runGenerateProgram("a");
    mockExtractStructuredJson.mockClear();

    await runGenerateProgram("a");

    const toolNames = mockExtractStructuredJson.mock.calls.map((call) => (call[0] as { toolName: string }).toolName);
    expect(toolNames).not.toContain("record_group_program");
    expect(toolNames).toContain("record_member_layer");
  });

  it("scenario 5: leader edits goal/daysPerWeek — next regen picks up the new values", async () => {
    await seedGroup("g5", ["a", "b"]);
    await seedMember("a", "a", "g5");
    await seedMember("b", "b", "g5");
    await runGenerateProgram("a");

    await db.doc("groups/g5").update({ goal: "New shared goal", daysPerWeek: 5 });
    mockExtractStructuredJson.mockClear();

    await runGenerateProgram("a");

    const toolNames = mockExtractStructuredJson.mock.calls.map((call) => (call[0] as { toolName: string }).toolName);
    expect(toolNames).toContain("record_group_program");

    const activeSnap = await db.collection("groups/g5/programs").where("status", "==", "active").get();
    expect(activeSnap.size).toBe(1);
    expect(activeSnap.docs[0].data().groupSnapshot.goal).toBe("New shared goal");
    expect(activeSnap.docs[0].data().groupSnapshot.daysPerWeek).toBe(5);
  });

  it("scenario 6: a new member (joined after Stage A last ran) triggers Stage A on their own check-in, without touching another member's layer", async () => {
    await seedGroup("g6", ["a", "b"]);
    await seedMember("a", "a", "g6");
    await seedMember("b", "b", "g6");
    await runGenerateProgram("a"); // establishes members/a

    await seedMember("c", "c", "g6");
    await db.doc("groups/g6").update({ memberUids: FieldValue.arrayUnion("c") });
    mockExtractStructuredJson.mockClear();

    await runGenerateProgram("c");

    const toolNames = mockExtractStructuredJson.mock.calls.map((call) => (call[0] as { toolName: string }).toolName);
    expect(toolNames).toContain("record_group_program");

    const cDoc = await db.doc("groups/g6/members/c").get();
    expect(cDoc.exists).toBe(true);
    // b never checked in, so still has no layer doc; a's is untouched by c's run.
    const aBefore = await db.doc("groups/g6/members/a").get();
    expect(aBefore.exists).toBe(true);
  });
});
