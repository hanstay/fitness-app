import { describe, it, expect } from "vitest";
import {
  structuralChanged, groupDetailsChanged, groupStructuralChange, decideRegen, blockPhaseIndex,
  inferBlockStart, roadmapForAdvance, buildContinuationText, phaseIndexForDate,
} from "../src/lib/programDecisions";

const baseAthlete = {
  goal: "Hyrox",
  events: [{ name: "Hyrox Singapore", date: "2026-11-01" }],
  training_days_per_week: 5,
  session_length_minutes: 60,
  preferred_split: "Upper/Lower",
  equipment: ["barbell", "dumbbells"],
  fixed_sessions: [{ day: "Tuesday", activity: "Hyrox class" }],
};

describe("structuralChanged", () => {
  it("is false for an identical snapshot", () => {
    expect(structuralChanged(baseAthlete, { ...baseAthlete })).toBe(false);
  });

  it("is true when there is no snapshot", () => {
    expect(structuralChanged(baseAthlete, null)).toBe(true);
  });

  it("flips on goal change", () => {
    expect(structuralChanged(baseAthlete, { ...baseAthlete, goal: "Marathon" })).toBe(true);
  });

  it("flips on events change", () => {
    expect(structuralChanged(baseAthlete, { ...baseAthlete, events: [] })).toBe(true);
  });

  it("flips on training_days_per_week change", () => {
    expect(structuralChanged(baseAthlete, { ...baseAthlete, training_days_per_week: 4 })).toBe(true);
  });

  it("flips on session_length_minutes change", () => {
    expect(structuralChanged(baseAthlete, { ...baseAthlete, session_length_minutes: 45 })).toBe(true);
  });

  it("flips on preferred_split change", () => {
    expect(structuralChanged(baseAthlete, { ...baseAthlete, preferred_split: "Push/Pull/Legs" })).toBe(true);
  });

  it("flips on equipment change", () => {
    expect(structuralChanged(baseAthlete, { ...baseAthlete, equipment: ["barbell"] })).toBe(true);
  });

  it("flips on fixed_sessions change", () => {
    expect(structuralChanged(baseAthlete, { ...baseAthlete, fixed_sessions: [] })).toBe(true);
  });

  it("is order-insensitive for equipment and fixed_sessions", () => {
    expect(structuralChanged(baseAthlete, {
      ...baseAthlete,
      equipment: ["dumbbells", "barbell"],
    })).toBe(false);
  });
});

const DAY = 86400000;
const at = (d: string) => new Date(`${d}T12:00:00Z`);
const ms = (d: string) => at(d).getTime();

const dated = [
  { phase: "Base", dates: "Sep 1 – Sep 28", startDate: "2026-09-01", endDate: "2026-09-28" },
  { phase: "Build", dates: "Sep 29 – Oct 26", startDate: "2026-09-29", endDate: "2026-10-26" },
  { phase: "Peak", dates: "Oct 27 – Nov 15", startDate: "2026-10-27", endDate: "2026-11-15" },
];
const undated = [{ phase: "Base" }, { phase: "Build" }, { phase: "Peak" }];

describe("phaseIndexForDate", () => {
  it("finds the phase, or the before/after sentinels, and null when undated", () => {
    expect(phaseIndexForDate(dated, "2026-10-01")).toBe(1);
    expect(phaseIndexForDate(dated, "2026-08-01")).toBe(-1);
    expect(phaseIndexForDate(dated, "2026-12-01")).toBe(3);
    expect(phaseIndexForDate(undated, "2026-10-01")).toBeNull();
    expect(phaseIndexForDate([], "2026-10-01")).toBeNull();
  });
});

describe("blockPhaseIndex", () => {
  it("prefers the stored index", () => {
    expect(blockPhaseIndex({ roadmap: dated, currentPhaseIndex: 2, blockStartedAtMs: ms("2026-09-02") }, "2026-09-10")).toBe(2);
  });
  it("falls back to the phase the block started in, then the first phase", () => {
    expect(blockPhaseIndex({ roadmap: dated, blockStartedAtMs: ms("2026-10-02") }, "2026-10-10")).toBe(1);
    expect(blockPhaseIndex({ roadmap: undated, blockStartedAtMs: ms("2026-10-02") }, "2026-10-10")).toBe(0);
  });
});

describe("decideRegen", () => {
  const decide = (state: Parameters<typeof decideRegen>[0]["state"], now: string, extra: Partial<Parameters<typeof decideRegen>[0]> = {}) =>
    decideRegen({ hasActiveProgram: true, structuralChange: false, state, force: false, now: at(now), ...extra });

  it("designs a new plan when there is none", () => {
    expect(decideRegen({ hasActiveProgram: false, structuralChange: false, state: {}, force: false }).mode).toBe("full");
  });

  it("redesigns — continuing from the current phase — when something structural changed", () => {
    const d = decide({ roadmap: dated, currentPhaseIndex: 1, blockStartedAtMs: ms("2026-09-29") }, "2026-10-05", { structuralChange: true });
    expect(d).toMatchObject({ mode: "full", fromPhaseIndex: 1, targetPhaseIndex: 1 });
  });

  it("is a weekly update while still inside the current phase", () => {
    expect(decide({ roadmap: dated, currentPhaseIndex: 0, blockStartedAtMs: ms("2026-09-01") }, "2026-09-20").mode).toBe("incremental");
  });

  it("advances (not redesigns) once the current phase's dates have ended", () => {
    expect(decide({ roadmap: dated, currentPhaseIndex: 0, blockStartedAtMs: ms("2026-09-01") }, "2026-10-01"))
      .toMatchObject({ mode: "advance", fromPhaseIndex: 0, targetPhaseIndex: 1 });
  });

  it("advances exactly one phase when asked, before the phase ends", () => {
    expect(decide({ roadmap: dated, currentPhaseIndex: 0, blockStartedAtMs: ms("2026-09-01") }, "2026-09-20", { force: true }))
      .toMatchObject({ mode: "advance", fromPhaseIndex: 0, targetPhaseIndex: 1 });
  });

  it("doesn't advance twice when asked after the phase already ended", () => {
    expect(decide({ roadmap: dated, currentPhaseIndex: 0, blockStartedAtMs: ms("2026-09-01") }, "2026-10-01", { force: true }))
      .toMatchObject({ mode: "advance", targetPhaseIndex: 1 });
  });

  it("stays in the phase it advanced into early, even though the dates say otherwise", () => {
    // Moved to Build on Sep 20 (stored index 1); today's date still falls in Base's original dates.
    expect(decide({ roadmap: dated, currentPhaseIndex: 1, blockStartedAtMs: ms("2026-09-20") }, "2026-09-25").mode).toBe("incremental");
  });

  it("isn't reset by weekly updates: an undated phase advances 6 weeks after the block started", () => {
    const state = { roadmap: undated, currentPhaseIndex: 0, blockStartedAtMs: ms("2026-08-01") };
    expect(decide(state, "2026-09-01").mode).toBe("incremental");
    expect(decide(state, "2026-09-20")).toMatchObject({ mode: "advance", targetPhaseIndex: 1 });
  });

  it("doesn't cut a dated phase short at 6 weeks", () => {
    const long = [{ phase: "Base", startDate: "2026-08-01", endDate: "2026-10-31" }, { phase: "Build", startDate: "2026-11-01", endDate: "2026-12-31" }];
    expect(decide({ roadmap: long, currentPhaseIndex: 0, blockStartedAtMs: ms("2026-08-01") }, "2026-10-01").mode).toBe("incremental");
  });

  it("designs the next plan once every phase is complete", () => {
    expect(decide({ roadmap: dated, currentPhaseIndex: 2, blockStartedAtMs: ms("2026-10-27") }, "2026-11-20"))
      .toMatchObject({ mode: "full", targetPhaseIndex: 3 });
    expect(decide({ roadmap: undated, currentPhaseIndex: 2, blockStartedAtMs: ms("2026-09-01") }, "2026-09-10", { force: true }))
      .toMatchObject({ mode: "full", targetPhaseIndex: 3 });
  });

  it("treats a new block on an open-ended plan (no roadmap) as a new plan", () => {
    expect(decide({ roadmap: [], blockStartedAtMs: ms("2026-09-01") }, "2026-09-10").mode).toBe("incremental");
    expect(decide({ roadmap: [], blockStartedAtMs: ms("2026-09-01") }, "2026-09-10", { force: true }).mode).toBe("full");
    expect(decide({ roadmap: [], blockStartedAtMs: ms("2026-07-01") }, "2026-09-10").mode).toBe("full");
  });
});

describe("inferBlockStart", () => {
  it("uses a stored blockStartedAt when present", () => {
    expect(inferBlockStart([{ createdAtMs: 5, roadmap: dated, blockStartedAtMs: 3 }])).toBe(3);
  });

  it("walks back through weekly updates sharing the same roadmap", () => {
    expect(inferBlockStart([
      { createdAtMs: 300, roadmap: undated },
      { createdAtMs: 200, roadmap: undated },
      { createdAtMs: 100, roadmap: undated },
      { createdAtMs: 50, roadmap: [{ phase: "Old" }] },
    ])).toBe(100);
  });

  it("is null with no programs", () => {
    expect(inferBlockStart([])).toBeNull();
  });
});

describe("roadmapForAdvance", () => {
  it("moving on early starts the next phase today and ends the current one yesterday, leaving later phases alone", () => {
    const r = roadmapForAdvance(dated, 1, "2026-09-20");
    expect(r[0]).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-19", dates: "Sep 1 – Sep 19" });
    expect(r[1]).toMatchObject({ startDate: "2026-09-20", endDate: "2026-10-26", dates: "Sep 20 – Oct 26" });
    expect(r[2]).toEqual(dated[2]);
    expect(dated[0].endDate).toBe("2026-09-28"); // input not mutated
  });

  it("leaves dates alone when the next phase has already started", () => {
    expect(roadmapForAdvance(dated, 1, "2026-10-01")).toEqual(dated);
  });

  it("leaves an undated roadmap unchanged", () => {
    expect(roadmapForAdvance(undated, 1, "2026-10-01")).toEqual(undated);
  });
});

describe("buildContinuationText", () => {
  const roadmap = dated.map((p, i) => ({ ...p, focus: ["Aerobic base", "Threshold", "Race-specific"][i], lifting: "Upper/Lower" }));

  it("is empty with no previous roadmap", () => {
    expect(buildContinuationText({ mode: "advance", roadmap: [], targetIndex: 0, reason: "x" })).toBe("");
  });

  it("advance: fixes the roadmap and details the phase to program", () => {
    const text = buildContinuationText({ mode: "advance", roadmap, targetIndex: 1, reason: "next phase requested" });
    expect(text).toContain("MOVING TO ITS NEXT PHASE (next phase requested)");
    expect(text).toContain("The roadmap below is FIXED");
    expect(text).toContain("Base (Sep 1 – Sep 28) [2026-09-01 → 2026-09-28] — focus: Aerobic base (COMPLETED)");
    expect(text).toContain("(← PROGRAM THIS BLOCK NOW)");
    expect(text).toContain(`Phase to program now: "Build"`);
    expect(text).toContain("  Lifting: Upper/Lower");
  });

  it("redesign: continues from the current phase", () => {
    const text = buildContinuationText({ mode: "full", roadmap, targetIndex: 1, reason: "goal, events or schedule changed" });
    expect(text).toContain("REDESIGN it because goal, events or schedule changed");
    expect(text).toContain(`currently in "Build"`);
  });

  it("redesign after the last phase asks for the next logical block, not a restart", () => {
    const text = buildContinuationText({ mode: "full", roadmap, targetIndex: 3, reason: "every phase of the plan is complete" });
    expect(text).toContain("Every phase of the previous roadmap is complete");
    expect(text).not.toContain("PROGRAM THIS BLOCK NOW");
  });
});

describe("groupDetailsChanged", () => {
  const baseGroup = {
    goal: "Get stronger together",
    daysPerWeek: 4,
    events: [{ name: "Hyrox Singapore", date: "2026-11-01" }],
    fixedSessions: [{ day: "Tuesday", activity: "Hyrox class" }],
  };

  it("is false for an identical snapshot", () => {
    expect(groupDetailsChanged(baseGroup, { ...baseGroup })).toBe(false);
  });

  it("is true when there is no snapshot", () => {
    expect(groupDetailsChanged(baseGroup, null)).toBe(true);
  });

  it("flips on goal change", () => {
    expect(groupDetailsChanged(baseGroup, { ...baseGroup, goal: "General fitness" })).toBe(true);
  });

  it("flips on daysPerWeek change", () => {
    expect(groupDetailsChanged(baseGroup, { ...baseGroup, daysPerWeek: 3 })).toBe(true);
  });

  it("flips on events change", () => {
    expect(groupDetailsChanged(baseGroup, { ...baseGroup, events: [] })).toBe(true);
  });

  it("flips on fixedSessions change", () => {
    expect(groupDetailsChanged(baseGroup, { ...baseGroup, fixedSessions: [] })).toBe(true);
  });

  it("is order-insensitive for events and fixedSessions", () => {
    expect(groupDetailsChanged(baseGroup, {
      ...baseGroup,
      events: [...baseGroup.events],
      fixedSessions: [...baseGroup.fixedSessions],
    })).toBe(false);
  });
});

describe("groupStructuralChange", () => {
  const partnerAthlete = { ...baseAthlete, goal: "Marathon", equipment: ["dumbbells"] };
  const group = { goal: "Get stronger together", daysPerWeek: 4, events: [], fixedSessions: [] };
  const snapshot = { profileSnapshots: { a: baseAthlete, b: partnerAthlete }, groupSnapshot: group };

  it("is false when nothing changed", () => {
    expect(groupStructuralChange({ memberAthletes: { a: baseAthlete, b: partnerAthlete }, group, activeProgram: snapshot })).toBe(false);
  });

  it("is true when a member's profile changed structurally", () => {
    expect(groupStructuralChange({
      memberAthletes: { a: { ...baseAthlete, training_days_per_week: 3 }, b: partnerAthlete }, group, activeProgram: snapshot,
    })).toBe(true);
  });

  it("is true when a member joined since the snapshot", () => {
    expect(groupStructuralChange({
      memberAthletes: { a: baseAthlete, b: partnerAthlete, c: baseAthlete }, group, activeProgram: snapshot,
    })).toBe(true);
  });

  it("is true when the leader edited the group's details", () => {
    expect(groupStructuralChange({
      memberAthletes: { a: baseAthlete, b: partnerAthlete }, group: { ...group, daysPerWeek: 5 }, activeProgram: snapshot,
    })).toBe(true);
  });
});
