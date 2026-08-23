import { describe, it, expect } from "vitest";
import { structuralChanged, needsFullRegen } from "../src/lib/programDecisions";

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
