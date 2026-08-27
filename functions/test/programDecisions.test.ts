import { describe, it, expect } from "vitest";
import { structuralChanged, needsFullRegen, needsGroupFullRegen, groupDetailsChanged } from "../src/lib/programDecisions";

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

describe("needsFullRegen", () => {
  const now = new Date("2026-08-18T00:00:00Z");

  it("is true when there's no active program", () => {
    expect(needsFullRegen({ athlete: baseAthlete, activeProgram: null, now })).toBe(true);
  });

  it("is true when the active program is stale (older than 6 weeks)", () => {
    const createdAt = new Date(now.getTime() - 7 * 7 * 24 * 60 * 60 * 1000);
    expect(needsFullRegen({
      athlete: baseAthlete,
      activeProgram: { profileSnapshot: baseAthlete, createdAt: { toMillis: () => createdAt.getTime() } },
      now,
    })).toBe(true);
  });

  it("is true when a structural input changed", () => {
    const createdAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(needsFullRegen({
      athlete: { ...baseAthlete, goal: "Marathon" },
      activeProgram: { profileSnapshot: baseAthlete, createdAt: { toMillis: () => createdAt.getTime() } },
      now,
    })).toBe(true);
  });

  it("is false for a routine, fresh, structurally-unchanged update", () => {
    const createdAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(needsFullRegen({
      athlete: baseAthlete,
      activeProgram: { profileSnapshot: baseAthlete, createdAt: { toMillis: () => createdAt.getTime() } },
      now,
    })).toBe(false);
  });

  it("is true when the active program has no reliable createdAt", () => {
    expect(needsFullRegen({
      athlete: baseAthlete,
      activeProgram: { profileSnapshot: baseAthlete, createdAt: null },
      now,
    })).toBe(true);
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

describe("needsGroupFullRegen", () => {
  const now = new Date("2026-08-18T00:00:00Z");
  const partnerAthlete = { ...baseAthlete, goal: "Marathon", equipment: ["dumbbells"] };
  const group = { goal: "Get stronger together", daysPerWeek: 4, events: [], fixedSessions: [] };
  const freshCreatedAt = { toMillis: () => now.getTime() - 7 * 24 * 60 * 60 * 1000 };
  const staleCreatedAt = { toMillis: () => now.getTime() - 7 * 7 * 24 * 60 * 60 * 1000 };

  it("is true when there's no group program yet", () => {
    expect(needsGroupFullRegen({
      memberAthletes: { a: baseAthlete, b: partnerAthlete },
      group,
      activeProgram: null,
      now,
    })).toBe(true);
  });

  it("is false for a routine, fresh, structurally-unchanged update across all members", () => {
    expect(needsGroupFullRegen({
      memberAthletes: { a: baseAthlete, b: partnerAthlete },
      group,
      activeProgram: {
        profileSnapshots: { a: baseAthlete, b: partnerAthlete },
        groupSnapshot: group,
        createdAt: freshCreatedAt,
      },
      now,
    })).toBe(false);
  });

  it("is true when any member's profile changed structurally", () => {
    expect(needsGroupFullRegen({
      memberAthletes: { a: baseAthlete, b: { ...partnerAthlete, training_days_per_week: 3 } },
      group,
      activeProgram: {
        profileSnapshots: { a: baseAthlete, b: partnerAthlete },
        groupSnapshot: group,
        createdAt: freshCreatedAt,
      },
      now,
    })).toBe(true);
  });

  it("is true when a member joined since the snapshot was taken", () => {
    expect(needsGroupFullRegen({
      memberAthletes: { a: baseAthlete, b: partnerAthlete, c: baseAthlete },
      group,
      activeProgram: {
        profileSnapshots: { a: baseAthlete, b: partnerAthlete },
        groupSnapshot: group,
        createdAt: freshCreatedAt,
      },
      now,
    })).toBe(true);
  });

  it("is true when the leader edited the group's goal/schedule since the snapshot", () => {
    expect(needsGroupFullRegen({
      memberAthletes: { a: baseAthlete, b: partnerAthlete },
      group: { ...group, daysPerWeek: 5 },
      activeProgram: {
        profileSnapshots: { a: baseAthlete, b: partnerAthlete },
        groupSnapshot: group,
        createdAt: freshCreatedAt,
      },
      now,
    })).toBe(true);
  });

  it("is true when the group program is stale (older than 6 weeks)", () => {
    expect(needsGroupFullRegen({
      memberAthletes: { a: baseAthlete, b: partnerAthlete },
      group,
      activeProgram: {
        profileSnapshots: { a: baseAthlete, b: partnerAthlete },
        groupSnapshot: group,
        createdAt: staleCreatedAt,
      },
      now,
    })).toBe(true);
  });

  it("is true when the group program has no reliable createdAt", () => {
    expect(needsGroupFullRegen({
      memberAthletes: { a: baseAthlete, b: partnerAthlete },
      group,
      activeProgram: {
        profileSnapshots: { a: baseAthlete, b: partnerAthlete },
        groupSnapshot: group,
        createdAt: null,
      },
      now,
    })).toBe(true);
  });
});
