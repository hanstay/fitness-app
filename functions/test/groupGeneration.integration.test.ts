// Emulator-backed: exercises the real runGenerateProgram/runGenerateGroupProgram
// orchestration (Stage A/B branching, archive-and-write batches,
// reconcileEvents, the check-in precondition ordering) against a real
// Firestore emulator, with only the LLM boundary mocked. Run via
// `firebase emulators:exec --only firestore --project demo-ci "npx vitest run test/groupGeneration.integration.test.ts"`
// — see functions/test/README.md.
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { FIXTURES, defaultFixtureResponse } from "./fixtures/llmFixtures";
import { runGenerateProgram } from "../src/generate/generateProgram";
import { REBUILD_CHANGE_NOTE } from "../src/lib/programDecisions";

// vi.mock calls are hoisted above imports by Vitest, so this takes effect
// before generateProgram.ts (and its groupProgram.ts import) load claude.ts.
const mockExtractStructuredJson = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/claude", () => ({
  extractStructuredJson: mockExtractStructuredJson,
  MODEL: "claude-sonnet-5-5",
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

// Pin the clock (Date only, so emulator I/O timers still run) inside the
// fixture roadmap's first phase (Base: 2026-08-11 to 2026-10-05). Unpinned,
// these tests start seeing that phase as ended once the real date passes it,
// and decideRegen correctly switches to "advance", which reruns Stage A.
vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-15T00:00:00Z") });
afterAll(() => {
  vi.useRealTimers();
});

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
    expect(memberDoc.data()?.inputsReadAt.toMillis()).toBeLessThanOrEqual(memberDoc.data()?.updatedAt.toMillis());
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

  // An older shared program: rewrites its stored days with `rename`.
  async function seedOlderProgram(groupId: string, rename: (day: string, i: number) => string) {
    await seedGroup(groupId, ["a"]);
    await seedMember("a", "a", groupId);
    await runGenerateProgram("a");
    const active = (await db.collection(`groups/${groupId}/programs`).where("status", "==", "active").get()).docs[0];
    const renamed = (entries: Array<{ day: string }>) => entries.map((e, i) => ({ ...e, day: rename(e.day, i) }));
    await active.ref.update({ weeklyStructure: renamed(active.data().weeklyStructure), sessions: renamed(active.data().sessions) });
    mockExtractStructuredJson.mockClear();
    return active;
  }

  it("scenario 7: an older shared week with abbreviated days only reruns Stage B, read as weekdays", async () => {
    await seedOlderProgram("g7", (day) => day.slice(0, 3));

    const result = await runGenerateProgram("a");

    const toolNames = mockExtractStructuredJson.mock.calls.map((call) => (call[0] as { toolName: string }).toolName);
    expect(toolNames).toEqual(["record_member_layer"]);
    expect(mockExtractStructuredJson.mock.calls[0][0].userText).toContain(`"day":"Monday"`);
    expect(result.sessions[0]).toMatchObject({ day: "Monday", exercises: [{ load_note: "Work up to a top set of 6 around 80kg." }, { load_note: "Moderate load, focus on drive." }] });
  });

  it("scenario 8: a shared week with days that aren't weekdays is rebuilt in Stage A for the same phase, keeping its roadmap", async () => {
    const before = await seedOlderProgram("g8", (_day, i) => `Day ${i + 1}`);
    const keptRoadmap = before.data().roadmap.map((p: Record<string, unknown>) => ({ ...p, phase: "Base (kept)" }));
    await before.ref.update({ roadmap: keptRoadmap });

    const result = await runGenerateProgram("a");

    const groupCall = mockExtractStructuredJson.mock.calls.find((c) => c[0].toolName === "record_group_program")!;
    expect(groupCall[0].userText).toContain("REBUILDING THIS PHASE'S WEEK");
    const after = (await db.collection("groups/g8/programs").where("status", "==", "active").get()).docs[0];
    expect(after.id).not.toBe(before.id);
    expect(after.data().roadmap).toEqual(keptRoadmap);
    expect(after.data().currentPhaseIndex).toBe(0);
    expect(after.data().blockStartedAt.toMillis()).toBe(before.data().blockStartedAt.toMillis());
    expect(after.data().sessions[0].day).toBe("Monday");
    expect(result.changeSummary?.[0]).toBe(REBUILD_CHANGE_NOTE);
  });

  it("scenario 10: the member's own layer answers their check-in notes and keeps the answers for What changed", async () => {
    await seedGroup("g10", ["a", "b"]);
    await seedMember("a", "a", "g10");
    await seedMember("b", "b", "g10");
    await runGenerateProgram("a");
    const note = (id: string, fields: Record<string, unknown>, ageMs: number) => db.doc(`users/a/feedbackNotes/${id}`).set({
      tags: ["pain"], text: "", exercise: null, day: null, duration: "week", worse: false, source: "checkin",
      createdAt: Timestamp.fromMillis(Date.now() - ageMs), ...fields,
    });
    await note("knee", { text: "Knee on lunges", exercise: "Walking Lunge (Dumbbell)", day: "Tuesday", duration: "ongoing", status: "pending" }, 2000);
    await note("move", {
      tags: ["checkin"], day: "Thursday", status: "pending", source: "checkin_question",
      checkin: { question: "You've skipped Thursday 3 of the last 4 weeks. Change it?", answer: "Move it: Sat", guidance: "Move the Thursday session to Saturday." },
    }, 1000);
    mockExtractStructuredJson.mockClear();
    mockExtractStructuredJson.mockImplementation(async (params: { toolName: string }) => ({
      ...(await defaultFixtureResponse(params) as object),
      ...(params.toolName === "record_member_layer" ? {
        feedbackResponses: [
          { id: "n1", status: "changed", response: "Do Box Step-Up (Dumbbell) at 16 kg in place of the lunges on Tuesday." },
          { id: "n2", status: "no_change", response: "The group's days are set for everyone, so it's one to raise with the group." },
        ],
      } : {}),
    }));

    await runGenerateProgram("a");

    const layerCall = mockExtractStructuredJson.mock.calls
      .map((c) => c[0] as { toolName: string; system: string; userText: string; inputSchema: { required: string[] } })
      .find((c) => c.toolName === "record_member_layer")!;
    expect(layerCall.system).toContain("The group's exercises and\ndays are shared and fixed");
    expect(layerCall.inputSchema.required).toContain("feedbackResponses");
    expect(layerCall.userText).toContain('[n1] NEW · Pain / discomfort · about "Walking Lunge (Dumbbell)" on Tuesday');
    expect(layerCall.userText).toContain('[n2] NEW · Check-in answer · about Thursday');

    const member = (await db.doc("groups/g10/members/a").get()).data()!;
    expect(member.feedbackResponses.map((r: { noteId: string; status: string }) => [r.noteId, r.status]))
      .toEqual([["knee", "changed"], ["move", "no_change"]]);
    expect(member.feedbackResponses[1]).toMatchObject({ question: expect.stringContaining("Thursday"), answer: "Move it: Sat" });
    const stored = async (id: string) => (await db.doc(`users/a/feedbackNotes/${id}`).get()).data()!;
    expect(await stored("knee")).toMatchObject({ status: "open", handledProgramId: member.groupProgramId });
    expect(await stored("move")).toMatchObject({ status: "done", response: { status: "no_change" } });

    // The next update with nothing new leaves the prompt alone and clears the answers.
    mockExtractStructuredJson.mockClear();
    mockExtractStructuredJson.mockImplementation(defaultFixtureResponse);
    await db.doc("users/a/feedbackNotes/knee").delete();
    await runGenerateProgram("a");
    const plain = mockExtractStructuredJson.mock.calls.map((c) => c[0] as { toolName: string; system: string }).find((c) => c.toolName === "record_member_layer")!;
    expect(plain.system).not.toContain("ATHLETE FEEDBACK");
    expect((await db.doc("groups/g10/members/a").get()).data()).not.toHaveProperty("feedbackResponses");
  });

  it("scenario 9: moving to the next phase stores the change summary on the member's doc until their next update", async () => {
    await seedGroup("g9", ["a", "b"]);
    await seedMember("a", "a", "g9");
    await seedMember("b", "b", "g9");
    const fixture = FIXTURES.record_group_program as { roadmap: Array<Record<string, unknown>> };
    const twoPhases = {
      ...fixture,
      roadmap: [fixture.roadmap[0], { ...fixture.roadmap[0], phase: "Build", dates: "Weeks 9-14", startDate: "2026-10-06", endDate: "2026-11-28" }],
    };
    mockExtractStructuredJson.mockImplementation(async (params: { toolName: string }) =>
      params.toolName === "record_group_program" ? twoPhases : defaultFixtureResponse(params));
    await runGenerateProgram("a");

    await runGenerateProgram("a", { force: true });
    const advanced = await db.doc("groups/g9/members/a").get();
    expect(advanced.data()?.changeSummary?.[0]).toContain("Base → Build");
    const active = await db.collection("groups/g9/programs").where("status", "==", "active").get();
    expect(advanced.data()?.groupProgramId).toBe(active.docs[0].id);

    await runGenerateProgram("a");
    const updated = await db.doc("groups/g9/members/a").get();
    expect(updated.data()).not.toHaveProperty("changeSummary");
  });
});
