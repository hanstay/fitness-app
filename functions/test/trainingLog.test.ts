import { describe, it, expect } from "vitest";
import {
  exercisesMatch, formatRecentLog, weeklySessionCounts, formatBestSetsByMonth,
  buildExerciseVocabulary, formatPrescription,
} from "../src/lib/trainingLog";
import type { StrengthSession, HevySet } from "../src/lib/hevyDerivedData";

const set = (weight_kg: number | null, reps: number | null, extra: Partial<HevySet> = {}): HevySet => ({
  index: 0, type: "normal", weight_kg, reps, distance_km: null, duration_seconds: null, rpe: null, ...extra,
});

const session = (date: string, title: string, exercises: Array<[string, HevySet[]]>): StrengthSession => ({
  id: `${date}-${title}`, date, title, start_time: `${date} 07:00`, end_time: `${date} 08:00`, source: "hevy",
  exercises: exercises.map(([name, sets]) => ({ name, sets })),
});

describe("exercisesMatch", () => {
  it.each([
    ["Barbell Squat", "Squat (Barbell)"],
    ["Back Squat", "Squat (Barbell)"],
    ["Bench Press", "Bench Press (Barbell)"],
    ["RDL (Dumbbell)", "Romanian Deadlift (Dumbbell)"],
    ["DB Row", "Dumbbell Row"],
    ["Pull-ups", "Pull Up"],
    ["Wall Balls", "Wall Ball"],
    ["squat (barbell)", "Squat (Barbell)"],
  ])("matches %s ↔ %s", (a, b) => {
    expect(exercisesMatch(a, b)).toBe(true);
    expect(exercisesMatch(b, a)).toBe(true);
  });

  it.each([
    ["Squat (Barbell)", "Split Squat (Dumbbell)"],
    ["Front Squat (Barbell)", "Squat (Barbell)"],
    ["Deadlift (Barbell)", "Romanian Deadlift (Barbell)"],
    ["Bench Press (Barbell)", "Incline Bench Press (Barbell)"],
    ["Barbell", "Squat (Barbell)"],
  ])("does not match %s ↔ %s", (a, b) => {
    expect(exercisesMatch(a, b)).toBe(false);
  });
});

describe("formatRecentLog", () => {
  const sessions = [
    session("2026-09-24", "Legs", [
      ["Squat (Barbell)", [set(60, 5, { type: "warmup" }), set(100, 5, { rpe: 8 }), set(100, 5, { rpe: 8 }), set(100, 4, { rpe: 9.5 })]],
      ["Pull Up", [set(null, 8), set(null, 7)]],
    ]),
    session("2026-09-20", "Upper", [["Bench Press (Barbell)", [set(80, 6), set(80, 6)]]]),
    session("2026-08-01", "Old", [["Bench Press (Barbell)", [set(70, 6)]]]),
  ];

  it("lists working sets oldest first, omits warm-ups and sessions outside the window, collapses repeats", () => {
    expect(formatRecentLog(sessions, "2026-09-27", 28)).toBe([
      `- 2026-09-20 "Upper": Bench Press (Barbell): 80kg×6 ×2`,
      `- 2026-09-24 "Legs": Squat (Barbell): 100kg×5 (RPE 8) ×2, 100kg×4 (RPE 9.5); Pull Up: 8 reps, 7 reps`,
    ].join("\n"));
  });

  it("says so when nothing was logged in the window", () => {
    expect(formatRecentLog(sessions, "2026-12-01", 28)).toBe("No Hevy sessions logged in the last 28 days.");
  });
});

describe("weeklySessionCounts", () => {
  it("counts sessions per trailing 7-day window, most recent first", () => {
    const s = ["2026-09-26", "2026-09-24", "2026-09-19", "2026-09-06"].map((d) => session(d, "x", []));
    expect(weeklySessionCounts(s, "2026-09-27", 4)).toEqual([2, 1, 0, 1]);
  });
});

describe("formatBestSetsByMonth", () => {
  it("shows the actual best set per month, ranked by estimated 1RM rather than raw weight", () => {
    const s = [
      session("2026-08-05", "a", [["Squat (Barbell)", [set(100, 1), set(90, 8)]]]),
      session("2026-09-10", "b", [["Squat (Barbell)", [set(95, 8, { rpe: 8 })]]]),
    ];
    expect(formatBestSetsByMonth(s, "2026-09-27")).toBe("- Squat (Barbell): 2026-08 90kg×8, 2026-09 95kg×8 @RPE 8");
  });

  it("skips lifts logged only once and unloaded exercises", () => {
    const s = [session("2026-09-10", "b", [["Squat (Barbell)", [set(95, 8)]], ["Pull Up", [set(null, 8)]]])];
    expect(formatBestSetsByMonth(s, "2026-09-27")).toBe("");
  });
});

describe("buildExerciseVocabulary", () => {
  it("lists recently logged names, most used first", () => {
    const s = [
      session("2026-09-24", "a", [["Squat (Barbell)", [set(100, 5)]], ["Wall Ball", [set(9, 20)]]]),
      session("2026-09-20", "b", [["Squat (Barbell)", [set(100, 5)]]]),
      session("2026-03-01", "c", [["Leg Press (Machine)", [set(200, 10)]]]),
    ];
    expect(buildExerciseVocabulary(s, "2026-09-27")).toEqual([
      { name: "Squat (Barbell)", sessions: 2, last: "2026-09-24" },
      { name: "Wall Ball", sessions: 1, last: "2026-09-24" },
    ]);
  });
});

describe("formatPrescription", () => {
  it("renders the prescribed week compactly", () => {
    expect(formatPrescription({
      title: "Hybrid Build",
      createdAtDate: "2026-09-20",
      weeklyStructure: [{ day: "Monday", focus: "Lower" }, { day: "Tuesday", focus: "Rest" }],
      sessions: [{
        day: "Monday", label: "Lower A",
        exercises: [
          { name: "Squat (Barbell)", sets: 4, reps: "5", rir: "2", load_note: "~100kg" },
          { name: "Zone-2 run", sets: 1, reps: "30 min", rir: "n/a", load_note: null },
        ],
      }],
    })).toBe([
      `Plan: "Hybrid Build", active since 2026-09-20`,
      `Week: Monday Lower · Tuesday Rest`,
      `- Monday "Lower A": Squat (Barbell) 4×5 RIR 2 [~100kg]; Zone-2 run 1×30 min`,
    ].join("\n"));
  });

  it("handles no plan", () => {
    expect(formatPrescription(null)).toBe("No current plan to compare against.");
  });
});
