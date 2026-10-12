import { describe, it, expect } from "vitest";
import { buildAdherenceSummary } from "../src/lib/hevyCheckinSummary";
import type { StrengthSession } from "../src/lib/hevyDerivedData";

const session = (date: string, names: string[]): StrengthSession => ({
  date,
  title: "Session",
  start_time: date,
  end_time: date,
  source: "hevy",
  exercises: names.map((name) => ({ name, sets: [] })),
});

describe("buildAdherenceSummary", () => {
  it("returns null without a program", () => {
    expect(buildAdherenceSummary(null, [session("2026-10-01", ["Squat"])])).toBeNull();
  });

  it("splits planned lifts into hit and missed, and lists extras as added", () => {
    const program = {
      title: "Block 1",
      sessions: [{ label: "Lower", exercises: [{ name: "Barbell Squat" }, { name: "Romanian Deadlift" }] }],
    };
    const result = buildAdherenceSummary(program, [
      session("2026-10-08", ["Squat (Barbell)", "Leg Press (Machine)"]),
    ]);
    expect(result).toMatchObject({
      programTitle: "Block 1",
      sessionsLogged: 1,
      hit: ["Barbell Squat"],
      missed: ["Romanian Deadlift"],
      added: ["Leg Press (Machine)"],
    });
  });

  it("ignores fixed class sessions and sessions outside the latest 14 days", () => {
    const program = {
      sessions: [
        { label: "Hyrox class", exercises: [{ name: "Wall Ball" }] },
        { label: "Upper", exercises: [{ name: "Bench Press" }] },
      ],
      profileSnapshot: { fixed_sessions: [{ activity: "Hyrox Class" }] },
    };
    const result = buildAdherenceSummary(program, [
      session("2026-09-01", ["Bench Press (Barbell)"]),
      session("2026-10-08", ["Pull Up"]),
    ]);
    expect(result).toMatchObject({ hit: [], missed: ["Bench Press"], added: ["Pull Up"], sessionsLogged: 1 });
  });
});
