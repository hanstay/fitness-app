// A program's day names are the key its weekly update merges sessions by
// (programMerge.ts) and a group member's loads are matched on
// (sessionLoads.ts), so new plans are locked to full weekday names
// (schemas.ts) and plans saved before that are normalised on read. No
// Firebase imports, so it's usable from both the functions and, duplicated
// by hand in public/js/days.js (a plain script with no build step to share
// this file across the client/server boundary), the dashboard's Today card —
// keep the two identical.

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The weekday a stored day name means ("Mon", "mon.", "MONDAY" and
 * "Monday (AM)" all mean "Monday"; "Tues" and "Th" mean "Tuesday" and
 * "Thursday"), or null when it names no weekday ("Day 1", "Rest", "").
 * Matches the leading word's first three letters, or both of a two-letter one.
 */
export function normalizeDay(raw: unknown): Weekday | null {
  const word = typeof raw === "string" ? raw.trim().toLowerCase().match(/^[a-z]+/)?.[0] ?? "" : "";
  if (word.length < 2) return null;
  return WEEKDAYS.find((d) => d.toLowerCase().startsWith(word.slice(0, 3))) ?? null;
}
