// Emulator-backed: the background program-generation hand-off — what
// queueProgramGeneration writes on its placeholder, and what
// onProgramGenerationRequested passes on to runGenerateProgram (mocked here;
// generateProgram/groupGeneration.integration.test.ts cover it), and which
// generation gets to settle the summary's status when they overlap. Run via
// `firebase emulators:exec --only firestore --project demo-ci "npx vitest run test/programGenerationQueue.integration.test.ts"`
// — see functions/test/README.md.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { queueProgramGeneration } from "../src/generate/queueProgramGeneration";
import { onProgramGenerationRequested } from "../src/generate/onProgramGenerationRequested";
import { sweepStaleGenerations } from "../src/generate/sweepStaleGenerations";

const mockRunGenerateProgram = vi.hoisted(() => vi.fn());
vi.mock("../src/generate/generateProgram", () => ({ runGenerateProgram: mockRunGenerateProgram }));

const db = getTestDb();

type QueueRequest = Parameters<typeof queueProgramGeneration.run>[0];
type TriggerEvent = Parameters<typeof onProgramGenerationRequested.run>[0];

async function seedUser(uid: string, athlete: Record<string, unknown>, summary: Record<string, unknown> = {}) {
  await db.doc(`users/${uid}`).set({ uid, athlete });
  await db.doc(`users/${uid}/state/summary`).set({ activeProgramSource: "personal", ...summary });
}

const queue = (uid: string, data?: unknown) =>
  queueProgramGeneration.run({ auth: { uid }, data } as unknown as QueueRequest) as Promise<{ programId: string }>;

// Delivers the placeholder's write to the trigger the way Eventarc would.
async function deliver(uid: string, programId: string) {
  const after = await db.doc(`users/${uid}/programs/${programId}`).get();
  await onProgramGenerationRequested.run({ params: { uid, programId }, data: { after } } as unknown as TriggerEvent);
}

beforeEach(async () => {
  await clearFirestoreEmulator();
  mockRunGenerateProgram.mockReset();
  mockRunGenerateProgram.mockResolvedValue({ programId: "new" });
});

describe("queued program generation", () => {
  const athlete = { training_days_per_week: 4, session_length_minutes: 60 };

  it("carries the check-in's force flag from the placeholder into runGenerateProgram", async () => {
    await seedUser("u1", athlete);

    const { programId } = await queue("u1", { force: true });
    expect((await db.doc(`users/u1/programs/${programId}`).get()).data()?.request).toEqual({ force: true });

    await deliver("u1", programId);

    expect(mockRunGenerateProgram).toHaveBeenCalledWith("u1", { force: true });
    expect((await db.doc(`users/u1/programs/${programId}`).get()).exists).toBe(false);
    const summary = (await db.doc("users/u1/state/summary").get()).data();
    expect(summary).not.toHaveProperty("programGenerationStatus");
    expect(summary).not.toHaveProperty("programGenerationStartedAt");
  });

  it("runs without force when queued with no inputs (onboarding, dashboard)", async () => {
    await seedUser("u2", athlete);

    const { programId } = await queue("u2");
    await deliver("u2", programId);

    expect(mockRunGenerateProgram).toHaveBeenCalledWith("u2", { force: false });
  });

  it("runs without force for a placeholder queued before inputs were stored", async () => {
    await seedUser("u3", athlete, { programGenerationStatus: "generating" });
    await db.doc("users/u3/programs/old").set({ status: "generating" });

    await deliver("u3", "old");

    expect(mockRunGenerateProgram).toHaveBeenCalledWith("u3", { force: false });
    expect((await db.doc("users/u3/state/summary").get()).data()).not.toHaveProperty("programGenerationStatus");
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
    await seedUser("u5", athlete);
    mockRunGenerateProgram.mockRejectedValue(new Error("model overloaded"));

    const { programId } = await queue("u5", { force: true });
    await deliver("u5", programId);

    const summary = (await db.doc("users/u5/state/summary").get()).data();
    expect(summary?.programGenerationStatus).toBe("error");
    expect(summary?.programGenerationError).toBe("model overloaded");
    expect((await db.doc(`users/u5/programs/${programId}`).get()).exists).toBe(false);
  });
});

describe("overlapping generations", () => {
  const athlete = { training_days_per_week: 4, session_length_minutes: 60 };
  const summaryOf = async (uid: string) => (await db.doc(`users/${uid}/state/summary`).get()).data();

  it("an older generation finishing leaves a newer one in flight", async () => {
    await seedUser("o1", athlete);
    const older = await queue("o1");
    const newer = await queue("o1");

    await deliver("o1", older.programId);
    expect((await db.doc(`users/o1/programs/${older.programId}`).get()).exists).toBe(false);
    expect(await summaryOf("o1")).toMatchObject({ programGenerationStatus: "generating", programGenerationId: newer.programId });

    await deliver("o1", newer.programId);
    expect(await summaryOf("o1")).not.toHaveProperty("programGenerationStatus");
  });

  it("an older generation failing doesn't mark a newer one as failed", async () => {
    await seedUser("o2", athlete);
    const older = await queue("o2");
    await queue("o2");
    mockRunGenerateProgram.mockRejectedValueOnce(new Error("model overloaded"));

    await deliver("o2", older.programId);

    const summary = await summaryOf("o2");
    expect(summary?.programGenerationStatus).toBe("generating");
    expect(summary).not.toHaveProperty("programGenerationError");
  });

  it("the stale sweep only fails the generation the summary is tracking", async () => {
    await seedUser("o3", athlete);
    const stalled = await queue("o3");
    const longAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
    await db.doc(`users/o3/programs/${stalled.programId}`).update({ createdAt: longAgo });
    await queue("o3");

    await sweepStaleGenerations.run({} as Parameters<typeof sweepStaleGenerations.run>[0]);

    expect((await db.doc(`users/o3/programs/${stalled.programId}`).get()).exists).toBe(false);
    expect((await summaryOf("o3"))?.programGenerationStatus).toBe("generating");

    // ...and does fail it once it's the latest one that stalled.
    const latest = await queue("o3");
    await db.doc(`users/o3/programs/${latest.programId}`).update({ createdAt: longAgo });
    await sweepStaleGenerations.run({} as Parameters<typeof sweepStaleGenerations.run>[0]);
    expect((await summaryOf("o3"))?.programGenerationStatus).toBe("error");
  });
});
