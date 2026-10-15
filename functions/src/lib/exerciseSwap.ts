// Swapping one exercise in the current plan from the Program page, and what
// the weekly update does with the swaps made since the last one. No Firebase
// imports, so it's unit-tested directly; the reasons and scopes are
// duplicated by hand in public/js/plan-feedback.js — keep the two identical.
import { z } from "zod";
import { exerciseSchema, SessionOutput } from "./schemas";
import { WEEKDAYS } from "./days";

export const SWAP_REASONS = ["hurts", "no_equipment", "dislike", "too_hard", "too_easy"] as const;
export type SwapReason = (typeof SWAP_REASONS)[number];

const REASON_LABEL: Record<SwapReason, string> = {
  hurts: "it hurts",
  no_equipment: "no equipment for it",
  dislike: "doesn't like it",
  too_hard: "too hard",
  too_easy: "too easy",
};
export const reasonLabel = (r: SwapReason): string => REASON_LABEL[r];

/** this_week: the next weekly update puts the original back. rest_of_block: kept until the phase ends. */
export const SWAP_SCOPES = ["this_week", "rest_of_block"] as const;
export type SwapScope = (typeof SWAP_SCOPES)[number];

export type Exercise = z.infer<typeof exerciseSchema>;

// What the AI suggests, and what the app sends back when one is picked.
export const swapOptionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  why: z.string().max(200),
  sets: z.number().int().min(1).max(12),
  reps: z.string().min(1).max(60),
  rir: z.string().max(20),
  rest_seconds: z.number().int().min(0).max(600),
  load_note: z.string().max(200).nullable(),
});
export type SwapOption = z.infer<typeof swapOptionSchema>;

export const swapOptionsSchema = z.object({ options: z.array(swapOptionSchema).min(1).max(3) });

export const swapOptionsJsonSchema = {
  type: "object",
  properties: {
    options: {
      type: "array",
      description: "Exactly 3 alternatives, best fit first.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exercise name, in the athlete's Hevy naming where they already do it." },
          why: { type: "string", description: "Why it fits, in under 12 plain words." },
          sets: { type: "integer" },
          reps: { type: "string" },
          rir: { type: "string", description: "Reps in reserve, or 'n/a' for conditioning." },
          rest_seconds: { type: "integer" },
          load_note: { type: ["string", "null"], description: "A conservative starting load, e.g. '2 × 14 kg', or null." },
        },
        required: ["name", "why", "sets", "reps", "rir", "rest_seconds", "load_note"],
      },
    },
  },
  required: ["options"],
};

export interface SwapRecord {
  id: string;
  day: (typeof WEEKDAYS)[number];
  /** Where the swapped exercise was when it was swapped; a hint, since a later update can reorder the week. */
  sessionIndex: number;
  exerciseIndex: number;
  from: Exercise;
  to: Exercise;
  reason: SwapReason;
  scope: SwapScope;
  /** The pain note a "Hurts" swap saved for the next check-in. */
  noteId: string | null;
  createdAt: string; // ISO
}

/** The swapped-in exercise as stored on the plan, from a picked option. */
export function toExercise(option: SwapOption): Exercise {
  return {
    name: option.name,
    sets: option.sets,
    reps: option.reps,
    rir: option.rir,
    rest_seconds: option.rest_seconds,
    load_note: option.load_note,
    substitution_note: null,
  };
}

/**
 * Where `name` is on `day`: at the hinted position if it's still there,
 * else its first occurrence that day. Null if the day no longer has it.
 */
export function locateExercise(
  sessions: SessionOutput[],
  day: string,
  name: string,
  hint?: { sessionIndex: number; exerciseIndex: number }
): { sessionIndex: number; exerciseIndex: number } | null {
  if (hint) {
    const s = sessions[hint.sessionIndex];
    if (s?.day === day && s.exercises[hint.exerciseIndex]?.name === name) return hint;
  }
  for (let si = 0; si < sessions.length; si++) {
    if (sessions[si].day !== day) continue;
    const ei = sessions[si].exercises.findIndex((ex) => ex.name === name);
    if (ei !== -1) return { sessionIndex: si, exerciseIndex: ei };
  }
  return null;
}

/** `sessions` with the exercise at `at` replaced by `exercise` (copied, not mutated). */
export function replaceExercise(
  sessions: SessionOutput[],
  at: { sessionIndex: number; exerciseIndex: number },
  exercise: Exercise
): SessionOutput[] {
  return sessions.map((s, si) => si !== at.sessionIndex ? s : {
    ...s,
    exercises: s.exercises.map((ex, ei) => (ei === at.exerciseIndex ? exercise : ex)),
  });
}

/**
 * Before a weekly update: the stored week with every swap that has run its
 * course put back, and the swaps still in force. A this-week swap ends at the
 * next update, unless it was made because it hurt and that pain note is
 * still being worked around (`activeNoteIds`). A rest-of-block swap carries
 * on (a new phase writes a fresh week, so it ends there; see
 * generateProgram.ts). A swap whose exercise is no longer in the week has
 * nothing left to undo.
 */
export function settleSwapsForUpdate(
  sessions: SessionOutput[],
  swaps: SwapRecord[],
  activeNoteIds: Set<string>
): { sessions: SessionOutput[]; kept: SwapRecord[] } {
  let week = sessions;
  const kept: SwapRecord[] = [];
  for (const swap of swaps) {
    const at = locateExercise(week, swap.day, swap.to.name, swap);
    if (!at) continue;
    const painStillOpen = swap.noteId != null && activeNoteIds.has(swap.noteId);
    const ends = swap.scope === "this_week" && !painStillOpen;
    if (ends) week = replaceExercise(week, at, swap.from);
    else kept.push({ ...swap, ...at });
  }
  return { sessions: week, kept };
}

/** After the update: the kept swaps whose exercise is still in the new week, at their new positions. */
export function swapsStillInWeek(sessions: SessionOutput[], swaps: SwapRecord[]): SwapRecord[] {
  return swaps.flatMap((swap) => {
    const at = locateExercise(sessions, swap.day, swap.to.name, swap);
    return at ? [{ ...swap, ...at }] : [];
  });
}

/** The prompt lines telling the update which swaps to keep. */
export function formatSwapsBlock(swaps: SwapRecord[]): string {
  if (!swaps.length) return "";
  return [
    "Exercise swaps the athlete made in the app (keep them; don't swap back while they're listed):",
    ...swaps.map((s) => `- ${s.day}: ${s.from.name} → ${s.to.name} (${reasonLabel(s.reason)})`),
  ].join("\n");
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The suggestions worth showing: none the day already has (the swapped-out one included), no repeats. */
export function freshOptions(options: SwapOption[], dayExerciseNames: string[]): SwapOption[] {
  const out: SwapOption[] = [];
  for (const option of options) {
    if (dayExerciseNames.some((n) => sameName(n, option.name))) continue;
    if (out.some((o) => sameName(o.name, option.name))) continue;
    out.push(option);
  }
  return out;
}

/** The swap whose swapped-in exercise is at `at`, if any. */
function swapAt(sessions: SessionOutput[], swaps: SwapRecord[], at: { sessionIndex: number; exerciseIndex: number }) {
  return swaps.find((s) => {
    const found = locateExercise(sessions, s.day, s.to.name, s);
    return found?.sessionIndex === at.sessionIndex && found.exerciseIndex === at.exerciseIndex;
  });
}

/**
 * Swaps the exercise at `at` for `to`. Swapping an exercise that was itself
 * swapped in replaces that swap, so the record still remembers the plan's
 * original exercise (and Undo puts that back).
 */
export function applySwap(
  sessions: SessionOutput[],
  swaps: SwapRecord[],
  at: { sessionIndex: number; exerciseIndex: number },
  to: Exercise,
  meta: Pick<SwapRecord, "id" | "reason" | "scope" | "noteId" | "createdAt">
): { sessions: SessionOutput[]; swaps: SwapRecord[]; record: SwapRecord } {
  const earlier = swapAt(sessions, swaps, at);
  const session = sessions[at.sessionIndex];
  const record: SwapRecord = {
    ...meta,
    noteId: meta.noteId ?? earlier?.noteId ?? null,
    day: session.day,
    ...at,
    from: earlier?.from ?? session.exercises[at.exerciseIndex],
    to,
  };
  return {
    sessions: replaceExercise(sessions, at, to),
    swaps: [...swaps.filter((s) => s !== earlier), record],
    record,
  };
}

/** Puts back the exercise a swap replaced. Null if there's no such swap or its exercise is gone. */
export function undoSwap(
  sessions: SessionOutput[],
  swaps: SwapRecord[],
  swapId: string
): { sessions: SessionOutput[]; swaps: SwapRecord[]; removed: SwapRecord } | null {
  const removed = swaps.find((s) => s.id === swapId);
  if (!removed) return null;
  const at = locateExercise(sessions, removed.day, removed.to.name, removed);
  if (!at) return null;
  return {
    sessions: replaceExercise(sessions, at, removed.from),
    swaps: swaps.filter((s) => s !== removed),
    removed,
  };
}
