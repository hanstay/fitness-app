// Emulator-backed: the background program-generation hand-off — what
// queueProgramGeneration writes on its placeholder, what
// onProgramGenerationRequested passes on to runGenerateProgram, and how the
// summary's generation status ends, including when generations overlap.
// Only the LLM boundary is mocked; runGenerateProgram is wrapped in a spy
// that calls through. Run via
// `firebase emulators:exec --only firestore --project demo-ci "npx vitest run test/programGenerationQueue.integration.test.ts"`
// — see functions/test/README.md.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { defaultFixtureResponse } from "./fixtures/llmFixtures";
import { runGenerateProgram } from "../src/generate/generateProgram";
import { queueProgramGeneration } from "../src/generate/queueProgramGeneration";
import { onProgramGenerationRequested } from "../src/generate/onProgramGenerationRequested";
import { sweepStaleGenerations } from "../src/generate/sweepStaleGenerations";

vi.mock("../src/lib/claude", () => ({
  extractStructuredJson: vi.fn(defaultFixtureResponse),
  MODEL: "claude-sonnet-5-5",
}));
vi.mock("../src/generate/generateProgram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/generate/generateProgram")>();
  return { ...actual, runGenerateProgram: vi.fn(actual.runGenerateProgram) };
});
const mockRunGenerateProgram = vi.mocked(runGenerateProgram);

const db = getTestDb();

type QueueRequest = Parameters<typeof queueProgramGeneration.run>[0];
type TriggerEvent = Parameters<typeof onProgramGenerationRequested.run>[0];

const athlete = {
  goal: "Get stronger", training_days_per_week: 4, session_length_minutes: 60,
  preferred_split: null, equipment: ["barbell"], events: [], fixed_sessions: [],
  injuries_constraints: "", current_lifts: [],
};

async function seedUser(uid: string, athleteFields: Record<string, unknown> = athlete, summary: Record<string, unknown> = {}) {
  await db.doc(`users/${uid}`).set({ uid, athlete: athleteFields });
  await db.doc(`users/${uid}/state/summary`).set({ activeProgramSource: "personal", ...summary });
}

const queue = (uid: string, data?: unknown) =>
  queueProgramGeneration.run({ auth: { uid }, data } as unknown as QueueRequest) as Promise<{ programId: string }>;

// Delivers the placeholder's write to the trigger the way Eventarc would.
async function deliver(uid: string, programId: string) {
  const after = await db.doc(`users/${uid}/programs/${programId}`).get();
  await onProgramGenerationRequested.run({ params: { uid, programId }, data: { after } } as unknown as TriggerEvent);
}

const summaryOf = async (uid: string) => (await db.doc(`users/${uid}/state/summary`).get()).data();
const placeholderExists = async (uid: string, programId: string) =>
  (await db.doc(`users/${uid}/programs/${programId}`).get()).exists;
const forceOfLastRun = () => mockRunGenerateProgram.mock.lastCall?.[1]?.force;
const sweep = () => sweepStaleGenerations.run({} as Parameters<typeof sweepStaleGenerations.run>[0]);

beforeEach(async () => {
  await clearFirestoreEmulator();
  mockRunGenerateProgram.mockClear();
});

describe("queued program generation", () => {
  it("carries the check-in's force flag into runGenerateProgram, and commits the program with the end of the generation", async () => {
    await seedUser("u1");

    const { programId } = await queue("u1", { force: true });
    expect((await db.doc(`users/u1/programs/${programId}`).get()).data()?.request).toEqual({ force: true });

    await deliver("u1", programId);

    expect(mockRunGenerateProgram).toHaveBeenCalledWith("u1", expect.objectContaining({ force: true }));
    expect(await placeholderExists("u1", programId)).toBe(false);
    const active = await db.collection("users/u1/programs").where("status", "==", "active").get();
    const summary = await summaryOf("u1");
    expect(summary?.currentProgramId).toBe(active.docs[0].id);
    expect(summary).not.toHaveProperty("programGenerationStatus");
    expect(summary).not.toHaveProperty("programGenerationStartedAt");
  });

  it("runs without force when queued with no inputs (onboarding, dashboard)", async () => {
    await seedUser("u2");

    const { programId } = await queue("u2");
    await deliver("u2", programId);

    expect(forceOfLastRun()).toBe(false);
  });

  it("runs without force, and still settles, for a placeholder queued before inputs and ids were stored", async () => {
    await seedUser("u3", athlete, { programGenerationStatus: "generating" });
    await db.doc("users/u3/programs/old").set({ status: "generating" });

    await deliver("u3", "old");

    expect(forceOfLastRun()).toBe(false);
    expect(await summaryOf("u3")).not.toHaveProperty("programGenerationStatus");
  });

  it("lets a group member without their own days/week queue an update", async () => {
    await seedUser("g1", {}, { activeProgramSource: "group", groupId: "grp" });

    await expect(queue("g1", { force: false })).resolves.toHaveProperty("programId");
  });

  it("still requires a personal training profile otherwise", async () => {
    await seedUser("u4", {});

    await expect(queue("u4")).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("records a failed generation on the summary", async () => {
    await seedUser("u5");
    mockRunGenerateProgram.mockRejectedValueOnce(new Error("model overloaded"));

    const { programId } = await queue("u5", { force: true });
    await deliver("u5", programId);

    const summary = await summaryOf("u5");
    expect(summary?.programGenerationStatus).toBe("error");
    expect(summary?.programGenerationError).toBe("model overloaded");
    expect(await placeholderExists("u5", programId)).toBe(false);
  });
});

describe("overlapping generations", () => {
  it("an older generation finishing writes its program but leaves a newer one in flight", async () => {
    await seedUser("o1");
    const older = await queue("o1");
    const newer = await queue("o1");

    await deliver("o1", older.programId);
    expect(await placeholderExists("o1", older.programId)).toBe(false);
    const summary = await summaryOf("o1");
    expect(summary?.currentProgramId).toBeTruthy();
    expect(summary).toMatchObject({ programGenerationStatus: "generating", programGenerationId: newer.programId });

    await deliver("o1", newer.programId);
    expect(await summaryOf("o1")).not.toHaveProperty("programGenerationStatus");
  });

  it("an older generation failing doesn't mark a newer one as failed", async () => {
    await seedUser("o2");
    const older = await queue("o2");
    await queue("o2");
    mockRunGenerateProgram.mockRejectedValueOnce(new Error("model overloaded"));

    await deliver("o2", older.programId);

    const summary = await summaryOf("o2");
    expect(summary?.programGenerationStatus).toBe("generating");
    expect(summary).not.toHaveProperty("programGenerationError");
  });

  it("the stale sweep only fails the generation the summary is tracking", async () => {
    await seedUser("o3");
    const stalled = await queue("o3");
    const longAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
    await db.doc(`users/o3/programs/${stalled.programId}`).update({ createdAt: longAgo });
    await queue("o3");

    await sweep();

    expect(await placeholderExists("o3", stalled.programId)).toBe(false);
    expect((await summaryOf("o3"))?.programGenerationStatus).toBe("generating");

    // ...and does fail it once it's the latest one that stalled.
    const latest = await queue("o3");
    await db.doc(`users/o3/programs/${latest.programId}`).update({ createdAt: longAgo });
    await sweep();
    expect((await summaryOf("o3"))?.programGenerationStatus).toBe("error");
  });
});

// The generateProgram onCall (groups.html, older cached check-in pages).
describe("direct generation", () => {
  it("clears a status left over from an earlier queued run", async () => {
    await seedUser("d1", athlete, { programGenerationStatus: "error", programGenerationId: "old" });

    await runGenerateProgram("d1");

    expect(await summaryOf("d1")).not.toHaveProperty("programGenerationStatus");
  });

  it("clears a stalled generation's status", async () => {
    const longAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
    await seedUser("d2", athlete, { programGenerationStatus: "generating", programGenerationStartedAt: longAgo, programGenerationId: "old" });

    await runGenerateProgram("d2");

    expect(await summaryOf("d2")).not.toHaveProperty("programGenerationStatus");
  });

  it("leaves a queued generation that's still in flight alone", async () => {
    await seedUser("d3");
    const { programId } = await queue("d3");

    await runGenerateProgram("d3");

    expect(await summaryOf("d3")).toMatchObject({ programGenerationStatus: "generating", programGenerationId: programId });
  });
});
