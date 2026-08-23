// Pure module for computing progression metrics from Hevy strength sessions.
// No Firebase imports — all functions are deterministic and testable.

export interface HevySet {
  index: number;
  type: string; // "warmup" or "normal"
  weight_kg: number | null;
  reps: number | null;
  distance_km: number | null;
  duration_seconds: number | null;
  rpe: number | null;
}

export interface HevyExercise {
  name: string;
  sets: HevySet[];
}

export interface StrengthSession {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  start_time: string;
  end_time: string;
  exercises: HevyExercise[];
  createdAt?: any;
  source: string;
}

export interface LiftProgression {
  exercise: string;
  e1RM: {
    current: number;
    pr: { weight_kg: number; date: string } | null;
    trend_6w: {
      direction: "↑" | "→" | "↓";
      percent_change: number;
      sample_dates: [string, string];
    } | null;
  };
  volume: {
    current_session: number;
    trend_6w: {
      direction: "↑" | "→" | "↓";
      avg_per_session: number;
      sessions_count: number;
    } | null;
  };
  frequency: {
    per_week: number;
    last_trained: string;
  };
}

export interface ProgressionConfig {
  lookbackDays: number;
  e1rmFormula: (weight_kg: number, reps: number) => number;
  trendThresholdPercent: number;
  topNKeyLifts: number;
  goalKeywords: Record<string, string[]>;
}

export const PROGRESSION_CONFIG: ProgressionConfig = {
  lookbackDays: 42,
  e1rmFormula: (w, r) => w * (1 + r / 30), // Epley
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

/**
 * Flatten nested exercises structure into a flat sets array (internal helper)
 */
function flattenSets(session: StrengthSession): Array<HevySet & { exercise: string }> {
  return session.exercises.flatMap((ex) =>
    ex.sets.map((set) => ({
      ...set,
      exercise: ex.name,
    }))
  );
}

/**
 * Compute estimated 1RM using Epley formula: weight × (1 + reps/30)
 */
export function computeE1RM(weight_kg: number, reps: number): number {
  return weight_kg * (1 + reps / 30);
}

/**
 * Extract the maximum E1RM from a single session for a given exercise.
 * Skips warmup sets, returns only the heaviest normal set.
 * Returns null if no normal sets exist or all weights are null/0.
 */
export function getMaxE1RMFromSession(
  exercise: string,
  session: StrengthSession,
  config: ProgressionConfig
): number | null {
  const sets = flattenSets(session);
  const normalSets = sets.filter(
    (s) => s.exercise === exercise && s.type === "normal" && s.weight_kg && s.weight_kg > 0 && s.reps
  );

  if (normalSets.length === 0) return null;

  // Find the set with the highest weight
  const heaviest = normalSets.reduce((max, set) => {
    if (!set.weight_kg) return max;
    return set.weight_kg > (max.weight_kg || 0) ? set : max;
  });

  if (!heaviest.weight_kg || !heaviest.reps) return null;
  return config.e1rmFormula(heaviest.weight_kg, heaviest.reps);
}

/**
 * Compute 6-week trend: compare oldest e1RM in lookback window to most recent.
 * Returns null if fewer than 2 sessions or if the exercise has no normal sets.
 */
export function computeTrend6Week(
  exercise: string,
  sessions: StrengthSession[],
  config: ProgressionConfig
): {
  direction: "↑" | "→" | "↓";
  percent_change: number;
  sample_dates: [string, string];
} | null {
  const cutoffMs = Date.now() - config.lookbackDays * 86400000;

  // Get all sessions within lookback window
  const inWindow = sessions.filter((s) => {
    const sessionMs = new Date(s.date).getTime();
    return sessionMs >= cutoffMs;
  });

  // Extract e1RMs for this exercise within window
  const e1rms = inWindow
    .map((s) => ({
      date: s.date,
      e1rm: getMaxE1RMFromSession(exercise, s, config),
    }))
    .filter((x) => x.e1rm !== null) as Array<{ date: string; e1rm: number }>;

  if (e1rms.length < 2) return null;

  // Sort by date to get oldest and newest
  e1rms.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const oldest = e1rms[0].e1rm;
  const newest = e1rms[e1rms.length - 1].e1rm;
  const percentChange = ((newest - oldest) / oldest) * 100;

  let direction: "↑" | "→" | "↓";
  if (percentChange > config.trendThresholdPercent) {
    direction = "↑";
  } else if (percentChange < -config.trendThresholdPercent) {
    direction = "↓";
  } else {
    direction = "→";
  }

  return {
    direction,
    percent_change: Math.round(percentChange * 10) / 10,
    sample_dates: [e1rms[0].date, e1rms[e1rms.length - 1].date],
  };
}

/**
 * Compute volume for a single session: sum of (sets × reps × weight_kg) for normal sets.
 * Skips warmup sets and bodyweight exercises (weight_kg=null or 0).
 */
export function computeVolumePerSession(exercise: string, session: StrengthSession): number {
  const sets = flattenSets(session);
  const normalSets = sets.filter(
    (s) => s.exercise === exercise && s.type === "normal" && s.weight_kg && s.weight_kg > 0 && s.reps
  );

  return normalSets.reduce((sum, set) => {
    if (!set.weight_kg || !set.reps) return sum;
    return sum + set.weight_kg * set.reps;
  }, 0);
}

/**
 * Compute frequency: sessions per week over lookback window, and last_trained date.
 */
export function computeFrequency(
  exercise: string,
  sessions: StrengthSession[],
  config: ProgressionConfig
): {
  per_week: number;
  last_trained: string;
} {
  const cutoffMs = Date.now() - config.lookbackDays * 86400000;

  // Filter sessions containing this exercise within lookback window
  const inWindow = sessions
    .filter((s) => {
      const sessionMs = new Date(s.date).getTime();
      return sessionMs >= cutoffMs;
    })
    .filter((s) => flattenSets(s).some((set) => set.exercise === exercise));

  if (inWindow.length === 0) {
    // No sessions in window; find the most recent ever
    const allWithExercise = sessions.filter((s) => flattenSets(s).some((set) => set.exercise === exercise));
    if (allWithExercise.length === 0) {
      return { per_week: 0, last_trained: "unknown" };
    }
    const mostRecent = allWithExercise.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    )[0];
    return { per_week: 0, last_trained: mostRecent.date };
  }

  // Compute sessions per week
  const weeksInWindow = config.lookbackDays / 7;
  const perWeek = inWindow.length / weeksInWindow;

  // Find most recent session
  const lastTrained = inWindow.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  )[0].date;

  return {
    per_week: Math.round(perWeek * 10) / 10,
    last_trained: lastTrained,
  };
}

/**
 * Find the PR (personal record) for an exercise: maximum e1RM across all time.
 */
export function findPR(
  exercise: string,
  sessions: StrengthSession[],
  config: ProgressionConfig
): { weight_kg: number; date: string } | null {
  const e1rms = sessions
    .map((s) => ({
      date: s.date,
      e1rm: getMaxE1RMFromSession(exercise, s, config),
    }))
    .filter((x) => x.e1rm !== null) as Array<{ date: string; e1rm: number }>;

  if (e1rms.length === 0) return null;

  const pr = e1rms.reduce((max, x) => (x.e1rm > max.e1rm ? x : max));
  return { weight_kg: Math.round(pr.e1rm * 10) / 10, date: pr.date };
}

/**
 * Compute full LiftProgression object with all metrics for a given exercise.
 */
export function computeLiftProgression(
  exercise: string,
  sessions: StrengthSession[],
  config: ProgressionConfig
): LiftProgression {
  // Find most recent session with this exercise
  const withExercise = sessions.filter((s) => flattenSets(s).some((set) => set.exercise === exercise));
  if (withExercise.length === 0) {
    throw new Error(`No sessions found for exercise: ${exercise}`);
  }

  const mostRecent = withExercise.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  )[0];

  const currentE1RM = getMaxE1RMFromSession(exercise, mostRecent, config);
  if (currentE1RM === null) {
    throw new Error(`No normal sets found for exercise: ${exercise}`);
  }

  // Compute current session volume
  const currentSessionVolume = computeVolumePerSession(exercise, mostRecent);

  // Compute 6-week volume trend
  const cutoffMs = Date.now() - config.lookbackDays * 86400000;
  const inWindow = sessions.filter((s) => {
    const sessionMs = new Date(s.date).getTime();
    return sessionMs >= cutoffMs;
  });

  const volumePerSessionList = inWindow
    .filter((s) => flattenSets(s).some((set) => set.exercise === exercise))
    .map((s) => computeVolumePerSession(exercise, s));

  const volumeTrend =
    volumePerSessionList.length < 2
      ? null
      : {
          direction: ((): "↑" | "→" | "↓" => {
            const avg1 = volumePerSessionList.slice(0, Math.floor(volumePerSessionList.length / 2)).reduce((a, b) => a + b, 0) /
              Math.ceil(volumePerSessionList.length / 2);
            const avg2 = volumePerSessionList.slice(Math.floor(volumePerSessionList.length / 2)).reduce((a, b) => a + b, 0) /
              Math.floor(volumePerSessionList.length / 2);
            const percentChange = ((avg2 - avg1) / avg1) * 100;
            if (percentChange > config.trendThresholdPercent) return "↑";
            if (percentChange < -config.trendThresholdPercent) return "↓";
            return "→";
          })(),
          avg_per_session: Math.round(
            (volumePerSessionList.reduce((a, b) => a + b, 0) / volumePerSessionList.length) * 10
          ) / 10,
          sessions_count: volumePerSessionList.length,
        };

  return {
    exercise,
    e1RM: {
      current: Math.round(currentE1RM * 10) / 10,
      pr: findPR(exercise, sessions, config),
      trend_6w: computeTrend6Week(exercise, sessions, config),
    },
    volume: {
      current_session: currentSessionVolume,
      trend_6w: volumeTrend,
    },
    frequency: computeFrequency(exercise, sessions, config),
  };
}

/**
 * Identify key lifts: top-N exercises by frequency in lookback window,
 * then augmented with goal keywords (add any goal-matching exercises even if not in top-N).
 */
export function identifyKeyLifts(sessions: StrengthSession[], config: ProgressionConfig): string[] {
  const cutoffMs = Date.now() - config.lookbackDays * 86400000;

  // Count frequency for each exercise in lookback window
  const frequencyMap = new Map<string, number>();
  for (const session of sessions) {
    const sessionMs = new Date(session.date).getTime();
    if (sessionMs < cutoffMs) continue;

    const sets = flattenSets(session);
    for (const set of sets) {
      frequencyMap.set(set.exercise, (frequencyMap.get(set.exercise) || 0) + 1);
    }
  }

  // Get top-N by frequency
  const topN = Array.from(frequencyMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.topNKeyLifts)
    .map(([exercise]) => exercise);

  // Augment with goal keywords
  const goalMatches = new Set<string>();
  for (const goalExercises of Object.values(config.goalKeywords)) {
    for (const goalExercise of goalExercises) {
      // Check if any session contains this goal exercise
      for (const session of sessions) {
        if (flattenSets(session).some((s) => s.exercise === goalExercise)) {
          goalMatches.add(goalExercise);
          break;
        }
      }
    }
  }

  // Combine top-N and goal matches, remove duplicates
  const keyLifts = Array.from(new Set([...topN, ...Array.from(goalMatches)]));
  return keyLifts;
}
