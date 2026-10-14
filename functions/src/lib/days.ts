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

// Each weekday's full name and its standard abbreviations, as whole words.
const DAY_BY_WORD = new Map<string, Weekday>([
  ["monday", "Monday"], ["mon", "Monday"],
  ["tuesday", "Tuesday"], ["tue", "Tuesday"], ["tues", "Tuesday"],
  ["wednesday", "Wednesday"], ["wed", "Wednesday"], ["weds", "Wednesday"],
  ["thursday", "Thursday"], ["thu", "Thursday"], ["thur", "Thursday"], ["thurs", "Thursday"],
  ["friday", "Friday"], ["fri", "Friday"],
  ["saturday", "Saturday"], ["sat", "Saturday"],
  ["sunday", "Sunday"], ["sun", "Sunday"],
]);

/**
 * The weekday a stored day name means, or null when it doesn't clearly name
 * one. It must start with a weekday's full name or standard abbreviation as
 * a whole word, in any case ("Mon", "mon.", "MONDAY", "Tue AM" and
 * "Monday (AM)" all work), and name no other weekday: "Day 1", "Monster",
 * "Sunrise run" and "Tue/Thu" give null.
 */
export function normalizeDay(raw: unknown): Weekday | null {
  const words = typeof raw === "string" ? raw.toLowerCase().match(/[a-z]+/g) ?? [] : [];
  const day = DAY_BY_WORD.get(words[0]);
  return day && words.every((w) => (DAY_BY_WORD.get(w) ?? day) === day) ? day : null;
}
