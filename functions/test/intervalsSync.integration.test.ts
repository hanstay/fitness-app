// syncIntervalsActivitiesForUser against the Firestore emulator, with
// intervals.icu stubbed: stores activities, and only reports new data when a
// sync brings in activities not stored before.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { syncIntervalsActivitiesForUser } from "../src/lib/intervalsClient";

const db = getTestDb();
const UID = "icu-user";

const activity = (id: number) => ({ id, start_date_local: "2026-10-10T07:00:00", type: "Run", name: `Run ${id}` });
let activities: object[] = [];

beforeEach(async () => {
  await clearFirestoreEmulator();
  await db.doc(`users/${UID}/state/summary`).set({ integrationsStatus: { intervalsIcu: { connected: true } } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.includes("/activities") ? activities : [{ id: "2026-10-10", ctl: 40, atl: 50 }]),
  })));
});
afterEach(() => vi.unstubAllGlobals());

const icuStatus = async () => (await db.doc(`users/${UID}/state/summary`).get()).data()?.integrationsStatus.intervalsIcu;

describe("syncIntervalsActivitiesForUser", () => {
  it("only moves lastNewDataAt when a sync brings activities not stored before", async () => {
    activities = [activity(1), activity(2)];
    expect(await syncIntervalsActivitiesForUser(UID, "token")).toMatchObject({ activitiesSynced: 2, newActivities: 2 });
    expect((await db.collection(`users/${UID}/activities`).get()).size).toBe(2);
    const firstNewAt = (await icuStatus()).lastNewDataAt.toMillis();

    expect(await syncIntervalsActivitiesForUser(UID, "token")).toMatchObject({ activitiesSynced: 2, newActivities: 0 });
    const afterResync = await icuStatus();
    expect(afterResync.newActivities).toBe(0);
    expect(afterResync.lastNewDataAt.toMillis()).toBe(firstNewAt);
    expect(afterResync.lastSyncedAt.toMillis()).toBeGreaterThanOrEqual(firstNewAt);

    activities = [activity(1), activity(2), activity(3)];
    expect(await syncIntervalsActivitiesForUser(UID, "token")).toMatchObject({ newActivities: 1 });
    const afterNew = await icuStatus();
    expect(afterNew.newActivities).toBe(1);
    expect(afterNew.lastNewDataAt.toMillis()).toBeGreaterThan(firstNewAt);
  });

  it("an empty sync writes no lastNewDataAt", async () => {
    activities = [];
    expect(await syncIntervalsActivitiesForUser(UID, "token")).toMatchObject({ activitiesSynced: 0, newActivities: 0 });
    expect((await icuStatus()).lastNewDataAt).toBeUndefined();
  });
});
