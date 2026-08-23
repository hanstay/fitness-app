import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { parseHevyCsvToCurrentLifts } from "../src/lib/hevyParser";

// A representative Hevy export committed alongside the tests (resolved relative
// to this file so it works on any machine). Its most recent session is dated
// within the parser's recency window relative to the fixed test date.
const SAMPLE_CSV_PATH = new URL("./fixtures/hevy-sample.csv", import.meta.url);

describe("parseHevyCsvToCurrentLifts", () => {
  it("extracts a plausible current-lifts snapshot from a real export", () => {
    const csv = readFileSync(SAMPLE_CSV_PATH, "utf8");
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

    // From the fixture: Squat (Barbell)'s most recent session is 2026-08-10,
    // whose last working set (warmups skipped, last normal row wins) is 95kg × 4.
    const squat = lifts.find((l) => l.exercise === "Squat (Barbell)");
    expect(squat).toBeDefined();
    expect(squat?.weight_kg).toBe(95);
    expect(squat?.reps).toBe(4);
    expect(squat?.date).toBe("2026-08-10");
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

  it("parses exports with mixed CRLF/LF line endings (seen from iOS)", () => {
    // Real iOS exports observed in the wild have most rows terminated with
    // \r\n but a handful of bare \n at workout boundaries, which previously
    // made csv-parse lock onto the wrong record delimiter and throw
    // "Invalid Opening Quote" on the stray \n.
    const csv = [
      "title,start_time,exercise_title,set_index,set_type,weight_kg,reps",
      '"A","Aug 1, 2026, 10:00 AM","Bench Press",0,"normal",80,5',
    ].join("\r\n") + "\n" + [
      '"B","Aug 2, 2026, 10:00 AM","Squat (Barbell)",0,"normal",95,4',
    ].join("\r\n") + "\r\n";
    const lifts = parseHevyCsvToCurrentLifts(csv);
    expect(lifts.map((l) => l.exercise).sort()).toEqual(["Bench Press", "Squat (Barbell)"]);
  });
});
