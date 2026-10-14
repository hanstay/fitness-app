// Weekday names — WEEKDAYS and normalizeDay are duplicated by hand from
// functions/src/lib/days.ts (no build step shares that file with the
// browser); keep the two identical. Plans written since day names were
// locked use these full names; older ones can say "Mon" or "Day 1".

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * The weekday a stored day name means ("Mon", "mon.", "MONDAY" and
 * "Monday (AM)" all mean "Monday"; "Tues" and "Th" mean "Tuesday" and
 * "Thursday"), or null when it names no weekday ("Day 1", "Rest", "").
 * Matches the leading word's first three letters, or both of a two-letter one.
 */
export function normalizeDay(raw) {
  const word = typeof raw === "string" ? raw.trim().toLowerCase().match(/^[a-z]+/)?.[0] ?? "" : "";
  if (word.length < 2) return null;
  return WEEKDAYS.find((d) => d.toLowerCase().startsWith(word.slice(0, 3))) ?? null;
}

/** Today's weekday in the athlete's own timezone (getDay() counts from Sunday). */
export function todayWeekday() {
  return WEEKDAYS[(new Date().getDay() + 6) % 7];
}
