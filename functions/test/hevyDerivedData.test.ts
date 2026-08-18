import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  computeE1RM,
  computeLiftProgression,
  identifyKeyLifts,
  getMaxE1RMFromSession,
  computeTrend6Week,
  computeVolumePerSession,
  computeFrequency,
  findPR,
  type StrengthSession,
  type HevySet,
} from "../src/lib/hevyDerivedData";

// Fixture dates below are all relative to this fixed "now" (the lookback
// windows are boundary-sensitive against Date.now()); freeze the clock so
// the suite doesn't drift out of its own 42-day window as real time passes.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

// Tests author sessions in a flat "one row per set" shape for readability;
// makeSession folds them into the canonical nested exercises[].sets[] structure
// the source consumes (grouping by exercise name, set.type = "normal"/"warmup").
interface FlatSet {
  exercise: string;
  set_type: string;
  weight_kg: number | null;
  reps: number | null;
}

function makeSession(date: string, flat: FlatSet[]): StrengthSession {
  const byExercise = new Map<string, HevySet[]>();
  flat.forEach((s, i) => {
    const sets = byExercise.get(s.exercise) ?? [];
    sets.push({
      index: i,
      type: s.set_type,
      weight_kg: s.weight_kg,
      reps: s.reps,
      distance_km: null,
      duration_seconds: null,
      rpe: null,
    });
    byExercise.set(s.exercise, sets);
  });
  return {
    id: date,
    date,
    title: "Workout",
    start_time: date,
    end_time: date,
    exercises: [...byExercise].map(([name, sets]) => ({ name, sets })),
    source: "hevy",
  };
}

describe("computeE1RM", () => {
  it("applies Epley formula: weight=100kg, reps=5 should yield ~117kg", () => {
    const e1rm = computeE1RM(100, 5);
    expect(e1rm).toBeCloseTo(117, 0); // 100 * (1 + 5/30) = 100 * 1.1667 = 116.67
  });

  it("handles single rep (weight=80kg, reps=1 should yield ~80kg)", () => {
    const e1rm = computeE1RM(80, 1);
    expect(e1rm).toBeCloseTo(82.7, 1); // 80 * (1 + 1/30) ≈ 82.67
  });

  it("handles high reps (weight=50kg, reps=10 should yield ~66kg)", () => {
    const e1rm = computeE1RM(50, 10);
    expect(e1rm).toBeCloseTo(66.7, 1); // 50 * (1 + 10/30) ≈ 66.67
  });
});

describe("computeE1RMFromSession", () => {
  it("picks the heaviest normal set from a session, skipping warmups", () => {
    const session = makeSession("2026-08-01", [
      { exercise: "Squat (Barbell)", set_type: "warmup", weight_kg: 40, reps: 5 },
      { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 100, reps: 3 },
      { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 110, reps: 2 },
      { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 105, reps: 2 },
    ]);
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // heaviest normal set is 110kg × 2 → 110 * (1 + 2/30) ≈ 117.33
    const e1rm = getMaxE1RMFromSession("Squat (Barbell)", session, config);
    expect(e1rm).toBeCloseTo(117.3, 1);
  });

  it("returns null for exercise with no normal sets (only warmups)", () => {
    const session = makeSession("2026-08-01", [
      { exercise: "Bench Press", set_type: "warmup", weight_kg: 40, reps: 5 },
      { exercise: "Bench Press", set_type: "warmup", weight_kg: 60, reps: 3 },
    ]);
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // No normal sets, so no e1RM
    const e1rm = getMaxE1RMFromSession("Bench Press", session, config);
    expect(e1rm).toBeNull();
  });

  it("handles bodyweight exercises (weight_kg=null or 0)", () => {
    const session = makeSession("2026-08-01", [
      { exercise: "Pull-ups", set_type: "normal", weight_kg: null, reps: 10 },
    ]);
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // Bodyweight exercise, can't compute e1RM
    const e1rm = getMaxE1RMFromSession("Pull-ups", session, config);
    expect(e1rm).toBeNull();
  });
});

describe("computeTrend6Week", () => {
  it("detects upward trend when recent e1RM is >5% higher than older e1RM", () => {
    const sessions = [
      makeSession("2026-07-01", [{ exercise: "Deadlift", set_type: "normal", weight_kg: 150, reps: 2 }]),
      makeSession("2026-08-11", [{ exercise: "Deadlift", set_type: "normal", weight_kg: 160, reps: 2 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // 160kg (reps 2) vs 150kg (reps 2): 160/150 = 1.067 = 6.7% gain => "↑"
    const trend = computeTrend6Week("Deadlift", sessions, config);
    expect(trend?.direction).toBe("↑");
    expect(trend?.percent_change).toBeCloseTo(6.7, 1);
  });

  it("detects downward trend when recent e1RM is >5% lower than older e1RM", () => {
    const sessions = [
      makeSession("2026-07-01", [{ exercise: "Bench Press", set_type: "normal", weight_kg: 100, reps: 3 }]),
      makeSession("2026-08-11", [{ exercise: "Bench Press", set_type: "normal", weight_kg: 90, reps: 3 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // 90kg vs 100kg: 90/100 = 0.9 = -10% loss => "↓"
    const trend = computeTrend6Week("Bench Press", sessions, config);
    expect(trend?.direction).toBe("↓");
    expect(trend?.percent_change).toBeCloseTo(-10, 1);
  });

  it("returns no trend (→) when e1RM change is within ±5%", () => {
    const sessions = [
      makeSession("2026-07-01", [{ exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 }]),
      makeSession("2026-08-11", [{ exercise: "Squat", set_type: "normal", weight_kg: 102, reps: 5 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // 102 vs 100: 2% change => "→"
    const trend = computeTrend6Week("Squat", sessions, config);
    expect(trend?.direction).toBe("→");
  });

  it("handles single session gracefully (no prior data)", () => {
    const sessions = [
      makeSession("2026-08-11", [{ exercise: "OHP", set_type: "normal", weight_kg: 60, reps: 5 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // Only one session, no trend
    const trend = computeTrend6Week("OHP", sessions, config);
    expect(trend).toBeNull();
  });
});

describe("computeVolumePerSession", () => {
  it("computes volume as sum of (sets * reps * weight_kg) per exercise", () => {
    const session = makeSession("2026-08-01", [
      { exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 },
      { exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 },
      { exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 },
    ]);
    // 3 sets × 5 reps × 100 kg = 1500 kg·reps
    const volume = computeVolumePerSession("Squat", session);
    expect(volume).toBe(1500);
  });

  it("handles bodyweight exercises gracefully (weight_kg=null or 0)", () => {
    const session = makeSession("2026-08-01", [
      { exercise: "Pull-ups", set_type: "normal", weight_kg: null, reps: 10 },
      { exercise: "Pull-ups", set_type: "normal", weight_kg: 0, reps: 10 },
    ]);
    // Bodyweight, volume = 0 for these exercises
    const volume = computeVolumePerSession("Pull-ups", session);
    expect(volume).toBe(0);
  });

  it("skips warmup sets in volume calculation", () => {
    const session = makeSession("2026-08-01", [
      { exercise: "Bench", set_type: "warmup", weight_kg: 40, reps: 10 },
      { exercise: "Bench", set_type: "normal", weight_kg: 80, reps: 8 },
      { exercise: "Bench", set_type: "normal", weight_kg: 80, reps: 8 },
    ]);
    // 2 sets × 8 reps × 80 kg = 1280 kg·reps (ignoring warmup)
    const volume = computeVolumePerSession("Bench", session);
    expect(volume).toBe(1280);
  });
});

describe("computeFrequency", () => {
  it("computes sessions per week over the 42-day lookback window", () => {
    const sessions = [
      makeSession("2026-07-01", [{ exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 }]),
      makeSession("2026-07-08", [{ exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 }]),
      makeSession("2026-07-15", [{ exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 }]),
      makeSession("2026-07-22", [{ exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 }]),
      makeSession("2026-07-29", [{ exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 }]),
      makeSession("2026-08-05", [{ exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 }]),
      makeSession("2026-08-11", [{ exercise: "Squat", set_type: "normal", weight_kg: 100, reps: 5 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // last_trained is deterministic; per_week depends on how many of these fall
    // inside the rolling 42-day window relative to "now" (boundary-sensitive).
    const freq = computeFrequency("Squat", sessions, config);
    expect(freq.per_week).toBeGreaterThan(0);
    expect(freq.last_trained).toBe("2026-08-11");
  });

  it("finds the most recent session as last_trained date", () => {
    const sessions = [
      makeSession("2026-07-01", [{ exercise: "Deadlift", set_type: "normal", weight_kg: 150, reps: 3 }]),
      makeSession("2026-08-11", [{ exercise: "Deadlift", set_type: "normal", weight_kg: 160, reps: 3 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // Most recent is 2026-08-11
    const freq = computeFrequency("Deadlift", sessions, config);
    expect(freq.last_trained).toBe("2026-08-11");
  });

  it("returns 0 per week if no sessions in lookback window", () => {
    const sessions = [
      makeSession("2026-06-01", [{ exercise: "OHP", set_type: "normal", weight_kg: 50, reps: 5 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // All sessions are >42 days old relative to "now" (2026-08-12)
    const freq = computeFrequency("OHP", sessions, config);
    expect(freq.per_week).toBe(0);
  });
});

describe("findPR", () => {
  it("finds the maximum e1RM across all time, with date", () => {
    const sessions = [
      makeSession("2026-07-01", [{ exercise: "Bench", set_type: "normal", weight_kg: 100, reps: 3 }]),
      makeSession("2026-07-15", [{ exercise: "Bench", set_type: "normal", weight_kg: 110, reps: 2 }]),
      makeSession("2026-08-11", [{ exercise: "Bench", set_type: "normal", weight_kg: 105, reps: 3 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // PR is 110kg on 2026-07-15: 110 * (1 + 2/30) ≈ 117.3
    const pr = findPR("Bench", sessions, config);
    expect(pr).toBeDefined();
    expect(pr?.weight_kg).toBeCloseTo(117.3, 1);
    expect(pr?.date).toBe("2026-07-15");
  });

  it("returns null if exercise has no normal sets", () => {
    const sessions = [
      makeSession("2026-08-11", [{ exercise: "Bench", set_type: "warmup", weight_kg: 40, reps: 5 }]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {},
    };
    // No normal sets
    const pr = findPR("Bench", sessions, config);
    expect(pr).toBeNull();
  });
});

describe("computeLiftProgression", () => {
  it("returns full LiftProgression object with all metrics", () => {
    const sessions = [
      makeSession("2026-06-01", [{ exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 140, reps: 5 }]),
      makeSession("2026-07-15", [{ exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 145, reps: 5 }]),
      makeSession("2026-08-11", [
        { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 150, reps: 3 },
        { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 150, reps: 3 },
        { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 150, reps: 3 },
      ]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 8,
      goalKeywords: {
        squat: ["Squat (Barbell)", "Front Squat", "Split Squat"],
        deadlift: ["Deadlift (Barbell)"],
        bench: ["Bench Press (Barbell)", "Incline Dumbbell Press"],
        hyrox: ["Sled Push", "Wall Ball", "Ski Erg", "Running"],
        crossfit: ["Wall Ball", "Burpees", "Sled Push"],
      },
    };
    const progression = computeLiftProgression("Squat (Barbell)", sessions, config);

    expect(progression).toBeDefined();
    expect(progression.exercise).toBe("Squat (Barbell)");
    expect(progression.e1RM).toBeDefined();
    expect(progression.e1RM.current).toBeGreaterThan(0);
    expect(progression.e1RM.pr).toBeDefined();
    expect(progression.volume).toBeDefined();
    expect(progression.volume.current_session).toBeGreaterThan(0);
    expect(progression.frequency).toBeDefined();
    expect(progression.frequency.per_week).toBeGreaterThan(0);
  });
});

describe("identifyKeyLifts", () => {
  it("returns top-N exercises by frequency from last 42 days", () => {
    const sessions = [
      makeSession("2026-07-01", [
        { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 140, reps: 5 },
        { exercise: "Deadlift (Barbell)", set_type: "normal", weight_kg: 150, reps: 3 },
      ]),
      makeSession("2026-07-08", [
        { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 140, reps: 5 },
        { exercise: "Bench Press (Barbell)", set_type: "normal", weight_kg: 100, reps: 5 },
      ]),
      makeSession("2026-07-15", [
        { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 145, reps: 5 },
        { exercise: "Leg Press", set_type: "normal", weight_kg: 200, reps: 8 },
      ]),
      makeSession("2026-08-11", [
        { exercise: "Squat (Barbell)", set_type: "normal", weight_kg: 150, reps: 3 },
        { exercise: "Bench Press (Barbell)", set_type: "normal", weight_kg: 105, reps: 5 },
      ]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 3,
      goalKeywords: {
        squat: ["Squat (Barbell)", "Front Squat", "Split Squat"],
        deadlift: ["Deadlift (Barbell)"],
        bench: ["Bench Press (Barbell)", "Incline Dumbbell Press"],
        hyrox: ["Sled Push", "Wall Ball", "Ski Erg", "Running"],
        crossfit: ["Wall Ball", "Burpees", "Sled Push"],
      },
    };
    const keyLifts = identifyKeyLifts(sessions, config);

    expect(Array.isArray(keyLifts)).toBe(true);
    expect(keyLifts.length).toBeGreaterThan(0);
    // Squat should be included (4 sessions), Bench (2), Deadlift (1), Leg Press (1)
    expect(keyLifts).toContain("Squat (Barbell)");
  });

  it("augments top-N with goal keywords", () => {
    const sessions = [
      makeSession("2026-08-11", [
        { exercise: "Wall Ball", set_type: "normal", weight_kg: 10, reps: 15 },
        { exercise: "Sled Push", set_type: "normal", weight_kg: 100, reps: 10 },
      ]),
    ];
    const config = {
      lookbackDays: 42,
      e1rmFormula: (w: number, r: number) => w * (1 + r / 30),
      trendThresholdPercent: 5,
      topNKeyLifts: 3,
      goalKeywords: {
        squat: ["Squat (Barbell)", "Front Squat", "Split Squat"],
        deadlift: ["Deadlift (Barbell)"],
        bench: ["Bench Press (Barbell)", "Incline Dumbbell Press"],
        hyrox: ["Sled Push", "Wall Ball", "Ski Erg", "Running"],
        crossfit: ["Wall Ball", "Burpees", "Sled Push"],
      },
    };
    const keyLifts = identifyKeyLifts(sessions, config);

    // Both Wall Ball and Sled Push should be included (they match "hyrox" & "crossfit" goals)
    expect(keyLifts).toContain("Wall Ball");
    expect(keyLifts).toContain("Sled Push");
  });
});
