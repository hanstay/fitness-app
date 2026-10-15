// saveHevySessions against the Firestore emulator: stores the sessions the
// browser parsed, keeps re-imports idempotent, and rejects malformed input.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { parseHevyCsvToSessions } from "../src/lib/hevyAnalyzer";
import { saveHevySessions, generateSessionId } from "../src/integrations/saveHevySessions";

const db = getTestDb();
const UID = "hevy-user";
const sessions = parseHevyCsvToSessions(readFileSync(join(__dirname, "fixtures", "hevy-sample.csv"), "utf8"));
const lifts = [{ exercise: "Squat (Barbell)", weight_kg: 90, reps: 5, date: "2026-08-10" }];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (data: unknown, uid: string | null = UID) => saveHevySessions.run({ data, auth: uid ? { uid } : undefined } as any);

beforeEach(async () => {
  await clearFirestoreEmulator();
  await db.doc(`users/${UID}`).set({ uid: UID, athlete: {} });
  await db.doc(`users/${UID}/state/summary`).set({ integrationsStatus: {} });
});

describe("saveHevySessions", () => {
  it("stores every session under its deterministic id, plus lifts and import status", async () => {
    const result = await call({ sessions, lifts });
    expect(result).toEqual({ sessionsImported: sessions.length, newSessions: sessions.length, liftsImported: 1 });

    const stored = await db.collection(`users/${UID}/strengthSessions`).get();
    expect(stored.size).toBe(sessions.length);
    const first = sessions[0];
    const doc = (await db.doc(`users/${UID}/strengthSessions/${generateSessionId(UID, first.start_time, first.title)}`).get()).data();
    expect(doc).toMatchObject({ title: first.title, date: first.date, source: "hevy", exercises: first.exercises });
    expect(doc?.createdAt).toBeDefined();

    const user = (await db.doc(`users/${UID}`).get()).data();
    expect(user?.athlete.current_lifts).toEqual(lifts);
    const status = (await db.doc(`users/${UID}/state/summary`).get()).data()?.integrationsStatus.hevy;
    const latest = sessions.map((s) => s.date).sort().at(-1);
    expect(status).toMatchObject({ csvUploaded: true, sessionsImported: sessions.length, newSessions: sessions.length, liftsImported: 1, lastSessionDate: latest, lastError: null });
    expect(status?.lastNewDataAt).toBeDefined();
  });

  it("re-importing the same export overwrites instead of duplicating", async () => {
    await call({ sessions, lifts });
    await call({ sessions, lifts });
    expect((await db.collection(`users/${UID}/strengthSessions`).get()).size).toBe(sessions.length);
  });

  it("only moves lastNewDataAt when an import brings sessions not stored before", async () => {
    const hevyStatus = async () => (await db.doc(`users/${UID}/state/summary`).get()).data()?.integrationsStatus.hevy;
    await call({ sessions: sessions.slice(1), lifts });
    const firstNewAt = (await hevyStatus()).lastNewDataAt.toMillis();

    expect(await call({ sessions: sessions.slice(1), lifts })).toMatchObject({ newSessions: 0 });
    const afterReimport = await hevyStatus();
    expect(afterReimport.newSessions).toBe(0);
    expect(afterReimport.lastNewDataAt.toMillis()).toBe(firstNewAt);

    expect(await call({ sessions, lifts })).toMatchObject({ newSessions: 1 });
    expect((await hevyStatus()).lastNewDataAt.toMillis()).toBeGreaterThan(firstNewAt);
    expect((await hevyStatus()).newSessions).toBe(1);
  });

  it("rejects malformed sessions and unauthenticated calls without writing", async () => {
    await expect(call({ sessions: [{ ...sessions[0], date: "not a date" }], lifts })).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(call({ sessions: [], lifts })).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(call({ sessions, lifts }, null)).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await db.collection(`users/${UID}/strengthSessions`).get()).size).toBe(0);
  });
});
