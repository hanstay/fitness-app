// The Program page's "Move day": swaps two days of the current week, with no
// model call. Everything keyed by day moves with them: the week's sessions and
// its weeklyStructure entries, the swaps made on it (exerciseSwap.ts), a group
// member's loads (sessionLoads.ts) and the notes waiting for the next update.
// No Firebase imports, so it's unit-tested directly.
import { normalizeWeek } from "./programMerge";
import { WEEKDAYS, Weekday, normalizeDay } from "./days";
import { ProgramOutput } from "./schemas";

type Week = Pick<ProgramOutput, "weeklyStructure" | "sessions">;

/** `day` with `a` and `b` swapped, as a full weekday name; any other day is left as it is. */
export function swapDayName(day: string, a: Weekday, b: Weekday): string {
  const weekday = normalizeDay(day);
  return weekday === a ? b : weekday === b ? a : day;
}

/** Each entry with `a` and `b` swapped in its `day` (copied, not mutated). */
export function withDaysSwapped<T extends { day: string }>(entries: T[], a: Weekday, b: Weekday): T[] {
  return entries.map((entry) => ({ ...entry, day: swapDayName(entry.day, a, b) }));
}

/**
 * The stored week with `a` and `b` swapped: each day's sessions, focus and
 * placement note move to the other day, and the weeklyStructure stays in
 * weekday order. Null if the week can't be read by weekday (an older plan's
 * "Day 1"), which only a plan update can fix.
 */
export function moveWeekDays(stored: { weeklyStructure?: unknown; sessions?: unknown }, a: Weekday, b: Weekday): Week | null {
  const week = normalizeWeek(stored as Parameters<typeof normalizeWeek>[0]);
  if (!week) return null;
  const order = (day: string) => WEEKDAYS.indexOf(day as Weekday);
  return {
    weeklyStructure: withDaysSwapped(week.weeklyStructure, a, b).sort((x, y) => order(x.day) - order(y.day)),
    sessions: withDaysSwapped(week.sessions, a, b),
  };
}

/**
 * A fixed weekly session (a class the athlete or group has committed to) on
 * either day, which the next update would put back on its day; it's moved
 * by changing the fixed sessions instead.
 */
export function fixedSessionOn(
  fixedSessions: Array<{ day: string; activity: string }> | null | undefined,
  a: Weekday,
  b: Weekday
): { day: Weekday; activity: string } | null {
  for (const s of fixedSessions ?? []) {
    const day = normalizeDay(s.day);
    if (day === a || day === b) return { day, activity: s.activity };
  }
  return null;
}
