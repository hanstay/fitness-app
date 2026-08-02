import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { parseHevyCsvToCurrentLifts } from "../src/lib/hevyParser";

// Real Hevy export from this session (users/maoledies), used as a fixture —
// per the plan's guidance to verify against real data, not synthetic rows.
const REAL_CSV_PATH =
  "C:/Users/js301/OneDrive/Documents/code/fitnesss-app/personal-trainer/users/maoledies/imports/workouts.csv";

describe("parseHevyCsvToCurrentLifts", () => {
  it("extracts a plausible current-lifts snapshot from a real export", () => {
    const csv = readFileSync(REAL_CSV_PATH, "utf8");
    const lifts = parseHevyCsvToCurrentLifts(csv);

    expect(lifts.length).toBeGreaterThan(0);
    expect(lifts.length).toBeLessThanOrEqual(40);

    // Newest-first ordering.
    const dates = lifts.map((l) => l.date);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);

    // Every entry has a real exercise name and a plausible weight/reps.
    for (const lift of lifts) {
      expect(lift.exercise.length).toBeGreaterThan(0);
      if (lift.weight_kg !== null) {
        expect(lift.weight_kg).toBeGreaterThan(0);
        expect(lift.weight_kg).toBeLessThan(500);
      }
      if (lift.reps !== null) {
        expect(lift.reps).toBeGreaterThan(0);
        expect(lift.reps).toBeLessThan(100);
      }
    }

    // Known real entry from the transcript: Squat (Barbell) 90kg x6 on 2026-07-21
    // was the most recent normal working set logged for that exercise.
    const squat = lifts.find((l) => l.exercise === "Squat (Barbell)");
    expect(squat).toBeDefined();
    expect(squat?.weight_kg).toBe(90);
    expect(squat?.reps).toBe(6);
    expect(squat?.date).toBe("2026-07-21");
  });

  it("skips warmup sets when picking the most recent working set", () => {
    const csv = [
      "title,start_time,exercise_title,set_index,set_type,weight_kg,reps",
      '"A","Aug 1, 2026, 10:00 AM","Bench Press",0,"warmup",40,10',
      '"A","Aug 1, 2026, 10:05 AM","Bench Press",1,"normal",80,5',
    ].join("\n");
    const lifts = parseHevyCsvToCurrentLifts(csv);
    expect(lifts).toHaveLength(1);
    expect(lifts[0]).toMatchObject({ exercise: "Bench Press", weight_kg: 80, reps: 5 });
  });

  it("converts lbs to kg when only a lbs column is present", () => {
    const csv = [
      "title,start_time,exercise_title,set_index,set_type,weight_lbs,reps",
      '"A","Aug 1, 2026, 10:00 AM","Deadlift",0,"normal",220,5',
    ].join("\n");
    const lifts = parseHevyCsvToCurrentLifts(csv);
    expect(lifts[0].weight_kg).toBeCloseTo(99.8, 1); // 220 lbs ≈ 99.8 kg
  });
});
