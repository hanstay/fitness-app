// public/js/plan-update-readiness.js: when the check-in's "Update my plan"
// has anything new to work from.
import { describe, it, expect } from "vitest";
// @ts-expect-error: a browser module with no types
import { planUpdateReadiness as readiness } from "../../public/js/plan-update-readiness.js";

const ts = (ms: number) => ({ toMillis: () => ms });
const plan = { updatedAt: ts(1000) };
const summary = (hevyNewAt: number | null, icuNewAt: number | null, connected = true) => ({
  integrationsStatus: {
    hevy: { parsedAt: ts(9000), newSessions: hevyNewAt != null ? 1 : 0, ...(hevyNewAt != null ? { lastNewDataAt: ts(hevyNewAt) } : {}) },
    intervalsIcu: { connected, lastSyncedAt: ts(9000), newActivities: icuNewAt != null ? 1 : 0, ...(icuNewAt != null ? { lastNewDataAt: ts(icuNewAt) } : {}) },
  },
});

describe("planUpdateReadiness", () => {
  it("waits when nothing new has been stored since the plan read its data", () => {
    // A recent import or sync with nothing new (parsedAt/lastSyncedAt only) doesn't count.
    expect(readiness({ summary: summary(null, null), plan }).ready).toBe(false);
    expect(readiness({ summary: summary(500, 500), plan }).ready).toBe(false);
  });

  it("is ready for new Hevy workouts or new intervals.icu activities", () => {
    expect(readiness({ summary: summary(2000, null), plan }).ready).toBe(true);
    expect(readiness({ summary: summary(null, 2000), plan }).ready).toBe(true);
  });

  it("ignores intervals.icu activities once it's disconnected", () => {
    const result = readiness({ summary: summary(null, 2000, false), plan });
    expect(result.ready).toBe(false);
    expect(result.hint).toMatch(/connect intervals\.icu/);
  });

  it("measures from when the plan read its data, so data stored mid-generation stays new", () => {
    const midRun = { inputsReadAt: ts(1000), updatedAt: ts(3000) };
    expect(readiness({ summary: summary(2000, null), plan: midRun }).ready).toBe(true);
    expect(readiness({ summary: summary(900, null), plan: midRun }).ready).toBe(false);
  });

  it("uses the import or sync time for a status written before new data was tracked", () => {
    const legacy = (hevyAt: number, icuAt: number) => ({
      integrationsStatus: { hevy: { parsedAt: ts(hevyAt) }, intervalsIcu: { connected: true, lastSyncedAt: ts(icuAt) } },
    });
    expect(readiness({ summary: legacy(2000, 500), plan }).ready).toBe(true);
    expect(readiness({ summary: legacy(500, 2000), plan }).ready).toBe(true);
    expect(readiness({ summary: legacy(500, 500), plan }).ready).toBe(false);
  });

  it("is ready when another member's update replaced the group's shared program", () => {
    expect(readiness({ summary: summary(null, null), plan: { ...plan, layerOutdated: true } }).ready).toBe(true);
    expect(readiness({ summary: summary(null, null), plan: { ...plan, layerOutdated: false } }).ready).toBe(false);
  });

  it("is ready for a profile change, an early next phase, or no plan yet", () => {
    expect(readiness({ summary: summary(null, null), plan, profileChanged: true }).ready).toBe(true);
    expect(readiness({ summary: summary(null, null), plan, startNextPhase: true }).ready).toBe(true);
    expect(readiness({ summary: {}, plan: null }).ready).toBe(true);
  });

  it("waits for an import or sync this page started", () => {
    expect(readiness({ summary: summary(2000, null), plan, hevyImporting: true })).toEqual({ ready: false, hint: "Importing your Hevy workouts…" });
    expect(readiness({ summary: summary(2000, null), plan, icuSyncing: true })).toEqual({ ready: false, hint: "Syncing intervals.icu…" });
    expect(readiness({ summary: summary(2000, null, false), plan, icuSyncing: true }).ready).toBe(true);
  });
});
