// Turns stored Hevy sessions into what a coach actually reads — the raw
// recent log, real best sets over time, and plain counts — plus the exercise
// name matching used to compare a plan against that log. Pure, no Firebase
// dependency, so it's unit-testable (see test/trainingLog.test.ts).
//
// This deliberately replaces pre-digested verdicts ("Good adherence",
// single-number e1RM trend arrows) in the generation prompt: those were lossy
// and often wrong, and steered the model toward conclusions it wouldn't reach
// from the log itself.
import type { StrengthSession, HevySet } from "./hevyDerivedData";

// ---------------------------------------------------------------------------
// Exercise name matching
// ---------------------------------------------------------------------------

// Whole-phrase rewrites applied before tokenizing — abbreviations and common
// names for a lift that Hevy spells differently.
const PHRASE_ALIASES: Array<[RegExp, string]> = [
  [/\bback squat\b/g, "squat barbell"],
  [/\brdl\b/g, "romanian deadlift"],
  [/\bsldl\b/g, "stiff leg deadlift"],
  [/\bohp\b/g, "overhead press"],
  [/\bpull[\s-]?ups?\b/g, "pull up"],
  [/\bchin[\s-]?ups?\b/g, "chin up"],
  [/\bpush[\s-]?ups?\b/g, "push up"],
  [/\bsit[\s-]?ups?\b/g, "sit up"],
  [/\bski[\s-]?erg\b/g, "ski erg"],
];

const TOKEN_ALIASES: Record<string, string> = {
  db: "dumbbell", dbs: "dumbbell", bb: "barbell", kb: "kettlebell", kbs: "kettlebell",
  bw: "bodyweight", ez: "ez", "e-z": "ez",
};

const STOPWORDS = new Set(["with", "and", "the", "of", "a", "on", "to"]);

// Equipment words: a name may omit these and still be the same lift
// ("Bench Press" vs "Bench Press (Barbell)"). Movement words may not
// ("Squat" vs "Split Squat" are different exercises).
const EQUIPMENT = new Set([
  "barbell", "dumbbell", "kettlebell", "cable", "machine", "smith", "bodyweight", "band",
  "weighted", "ez", "bar", "trap", "hex", "plate", "landmine", "assisted", "single", "arm",
]);

function stem(token: string): string {
  // Crude plural strip, applied to both sides so it only needs to be consistent.
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

export function exerciseTokens(name: string): Set<string> {
  let s = name.toLowerCase();
  for (const [re, rep] of PHRASE_ALIASES) s = s.replace(re, rep);
  const tokens = s
    .replace(/[()[\],/+&]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .map((t) => TOKEN_ALIASES[t] ?? t)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
  return new Set(tokens);
}

/**
 * True if two exercise names plausibly refer to the same lift: the same words
 * in any order ("Barbell Squat" / "Squat (Barbell)"), or one name is the other
 * plus only equipment words ("Bench Press" / "Bench Press (Barbell)").
 */
export function exercisesMatch(a: string, b: string): boolean {
  const ta = exerciseTokens(a);
  const tb = exerciseTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!big.has(t)) return false;
  for (const t of big) if (!small.has(t) && !EQUIPMENT.has(t)) return false;
  // Don't let a name that's nothing but equipment ("Barbell") match anything.
  return [...small].some((t) => !EQUIPMENT.has(t));
}

// ---------------------------------------------------------------------------
// Formatting the log
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

function daysBefore(dateStr: string, days: number): string {
  return new Date(new Date(dateStr).getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function workingSets(sets: HevySet[]): HevySet[] {
  return sets.filter((s) => s.type !== "warmup");
}

function formatSet(s: HevySet): string {
  let core: string;
  if (s.weight_kg && s.reps) core = `${round1(s.weight_kg)}kg×${s.reps}`;
  else if (s.reps) core = `${s.reps} reps`;
  else if (s.distance_km) core = `${round1(s.distance_km * 1000)}m`;
  else if (s.duration_seconds) core = `${Math.round(s.duration_seconds)}s`;
  else core = "set";
  if (s.weight_kg && !s.reps && (s.distance_km || s.duration_seconds)) core = `${round1(s.weight_kg)}kg ${core}`;
  const tags = [
    s.rpe != null ? `RPE ${s.rpe}` : null,
    s.type === "failure" ? "to failure" : s.type === "dropset" || s.type === "drop" ? "drop set" : null,
  ].filter(Boolean);
  return tags.length ? `${core} (${tags.join(", ")})` : core;
}

/** "80kg×6, 80kg×6, 80kg×5" → "80kg×6 ×2, 80kg×5" — keeps every set's detail, just shorter. */
function formatSets(sets: HevySet[]): string {
  const parts: string[] = [];
  let prev: string | null = null;
  let count = 0;
  const flush = () => { if (prev) parts.push(count > 1 ? `${prev} ×${count}` : prev); };
  for (const s of sets) {
    const f = formatSet(s);
    if (f === prev) { count++; continue; }
    flush();
    prev = f;
    count = 1;
  }
  flush();
  return parts.join(", ");
}

function sortedAsc(sessions: StrengthSession[]): StrengthSession[] {
  return [...sessions].sort((a, b) => (a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date)));
}

/**
 * Every logged working set from the last `days` days, oldest first, one line
 * per session — the same view a coach gets scrolling the athlete's Hevy log.
 */
export function formatRecentLog(sessions: StrengthSession[], today: string, days = 28, maxSessions = 40): string {
  const since = daysBefore(today, days);
  const recent = sortedAsc(sessions.filter((s) => s.date >= since)).slice(-maxSessions);
  if (recent.length === 0) return `No Hevy sessions logged in the last ${days} days.`;
  return recent
    .map((s) => {
      const exercises = s.exercises
        .map((ex) => ({ name: ex.name, sets: workingSets(ex.sets) }))
        .filter((ex) => ex.sets.length > 0)
        .map((ex) => `${ex.name}: ${formatSets(ex.sets)}`);
      return `- ${s.date} "${s.title}": ${exercises.join("; ") || "(no working sets)"}`;
    })
    .join("\n");
}

/** Sessions logged in each of the last `weeks` 7-day windows, most recent first. */
export function weeklySessionCounts(sessions: StrengthSession[], today: string, weeks = 4): number[] {
  const counts: number[] = [];
  for (let w = 0; w < weeks; w++) {
    const end = daysBefore(today, w * 7);
    const start = daysBefore(today, (w + 1) * 7);
    counts.push(sessions.filter((s) => s.date > start && s.date <= end).length);
  }
  return counts;
}

function epley(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

/**
 * For the athlete's most-trained loaded lifts, the actual best set per month
 * over the last `months` months — the long-horizon view that doesn't fit as a
 * raw log. "Best" is ranked by estimated 1RM so a 90kg×8 outranks 100kg×1,
 * but the set itself is what's shown, not the estimate.
 */
export function formatBestSetsByMonth(sessions: StrengthSession[], today: string, months = 6, maxLifts = 6): string {
  const since = daysBefore(today, months * 31);
  const inRange = sessions.filter((s) => s.date >= since);

  const sessionCount = new Map<string, number>();
  for (const s of inRange) {
    for (const ex of s.exercises) {
      if (ex.sets.some((set) => set.type !== "warmup" && set.weight_kg && set.reps)) {
        sessionCount.set(ex.name, (sessionCount.get(ex.name) ?? 0) + 1);
      }
    }
  }
  const lifts = [...sessionCount.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxLifts)
    .map(([name]) => name);
  if (lifts.length === 0) return "";

  const lines = lifts.map((lift) => {
    const bestByMonth = new Map<string, HevySet>();
    for (const s of inRange) {
      const month = s.date.slice(0, 7);
      for (const ex of s.exercises) {
        if (ex.name !== lift) continue;
        for (const set of workingSets(ex.sets)) {
          if (!set.weight_kg || !set.reps) continue;
          const cur = bestByMonth.get(month);
          if (!cur || epley(set.weight_kg, set.reps) > epley(cur.weight_kg!, cur.reps!)) bestByMonth.set(month, set);
        }
      }
    }
    const parts = [...bestByMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, set]) => `${month} ${round1(set.weight_kg!)}kg×${set.reps}${set.rpe != null ? ` @RPE ${set.rpe}` : ""}`);
    return `- ${lift}: ${parts.join(", ")}`;
  });
  return lines.join("\n");
}

export interface ExerciseVocabEntry {
  name: string;
  sessions: number;
  last: string;
}

/**
 * The exercise names the athlete has actually logged in Hevy recently, most
 * used first — handed to the model so the plan reuses the athlete's own names
 * (and so plan-vs-log comparison matches by construction).
 */
export function buildExerciseVocabulary(sessions: StrengthSession[], today: string, days = 90, max = 60): ExerciseVocabEntry[] {
  const since = daysBefore(today, days);
  const byName = new Map<string, ExerciseVocabEntry>();
  for (const s of sessions) {
    if (s.date < since) continue;
    for (const ex of s.exercises) {
      const cur = byName.get(ex.name) ?? { name: ex.name, sessions: 0, last: s.date };
      cur.sessions++;
      if (s.date > cur.last) cur.last = s.date;
      byName.set(ex.name, cur);
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.sessions - a.sessions || b.last.localeCompare(a.last))
    .slice(0, max);
}

export function formatExerciseVocabulary(vocab: ExerciseVocabEntry[]): string {
  if (vocab.length === 0) return "none logged yet";
  return vocab.map((v) => `- ${v.name} (${v.sessions}×, last ${v.last})`).join("\n");
}

// ---------------------------------------------------------------------------
// The plan being compared against
// ---------------------------------------------------------------------------

export interface PrescriptionProgram {
  title?: string | null;
  createdAtDate?: string | null;
  weeklyStructure?: Array<{ day: string; focus: string }> | null;
  sessions?: Array<{
    day: string;
    label?: string;
    exercises?: Array<{ name?: string; sets?: number; reps?: string; rir?: string; load_note?: string | null }>;
  }> | null;
}

/** The prescribed week the athlete was meant to be following, in the same compact style as the log. */
export function formatPrescription(program: PrescriptionProgram | null): string {
  if (!program || !(program.sessions ?? []).length) return "No current plan to compare against.";
  const header = `Plan: "${program.title ?? "current plan"}"${program.createdAtDate ? `, active since ${program.createdAtDate}` : ""}`;
  const week = (program.weeklyStructure ?? []).length
    ? `Week: ${(program.weeklyStructure ?? []).map((d) => `${d.day} ${d.focus}`).join(" · ")}`
    : null;
  const sessions = (program.sessions ?? []).map((s) => {
    const exercises = (s.exercises ?? [])
      .filter((ex) => ex.name)
      .map((ex) => {
        const rir = ex.rir && ex.rir !== "n/a" ? ` RIR ${ex.rir}` : "";
        const load = ex.load_note ? ` [${ex.load_note}]` : "";
        return `${ex.name} ${ex.sets ?? "?"}×${ex.reps ?? "?"}${rir}${load}`;
      });
    return `- ${s.day}${s.label ? ` "${s.label}"` : ""}: ${exercises.join("; ")}`;
  });
  return [header, week, ...sessions].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Cardio activity formatting (intervals.icu)
// ---------------------------------------------------------------------------

/**
 * Labels an activity's average HR against the athlete's HR zone boundaries
 * (intervals.icu's per-zone upper bounds, e.g. [157,167,176,186,191,197,206]
 * for Z1..Z7). Returns null if either input is missing — callers should omit
 * the label rather than show a wrong one.
 */
export function hrZoneLabel(avgHr: number | null | undefined, hrZones: number[] | null | undefined): string | null {
  if (avgHr == null || !hrZones || hrZones.length === 0) return null;
  const idx = hrZones.findIndex((upperBound) => avgHr <= upperBound);
  const zone = idx === -1 ? hrZones.length : idx + 1;
  return `Z${zone}`;
}

/** "Z1 ≤157, Z2 158-167, ..." — the athlete's HR zone boundaries, shown once above the activity list. */
export function formatHrZoneLegend(hrZones: number[]): string {
  const ranges = hrZones.map((upper, i) => {
    if (i === 0) return `Z1 ≤${upper}`;
    const lower = hrZones[i - 1] + 1;
    const isLast = i === hrZones.length - 1;
    return `Z${i + 1} ${isLast ? `${lower}+` : `${lower}-${upper}`}`;
  });
  return `HR zones (bpm, per most recent activity): ${ranges.join(", ")}`;
}
