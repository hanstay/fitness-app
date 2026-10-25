// The Program page's "Rearrange week": puts the current week's days in a new
// order, with no model call. Everything keyed by day moves with them: the
// week's sessions and its weeklyStructure entries, the swaps made on it
// (exerciseSwap.ts), a group member's loads (sessionLoads.ts) and the notes
// waiting for the next update. No Firebase imports, so it's unit-tested
// directly.
import { normalizeWeek } from "./programMerge";
import { WEEKDAYS, Weekday, normalizeDay } from "./days";
import { ProgramOutput } from "./schemas";

type Week = Pick<ProgramOutput, "weeklyStructure" | "sessions">;

/** Where each moved day's sessions go: { Monday: "Thursday", Tuesday: "Monday", ... }. Days left out stay put. */
export type DayMoves = Partial<Record<Weekday, Weekday>>;

const isWeekday = (v: unknown): v is Weekday => typeof v === "string" && (WEEKDAYS as readonly string[]).includes(v);

/** The moves that swap `a` and `b` (the older two-day "Move day" request). */
export const swapMoves = (a: Weekday, b: Weekday): DayMoves => ({ [a]: b, [b]: a });

/**
 * `raw` as moves, with the days that don't move dropped, or null unless it
 * reorders the week: every key and value a full weekday name, and the days
 * moved off exactly the days moved onto, so no two days land on one.
 */
export function readMoves(raw: unknown): DayMoves | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const moves: DayMoves = {};
  for (const [from, to] of Object.entries(raw)) {
    if (!isWeekday(from) || !isWeekday(to)) return null;
    if (from !== to) moves[from] = to;
  }
  const froms = Object.keys(moves).sort();
  const tos = Object.values(moves).sort();
  if (!froms.length || new Set(tos).size !== tos.length || froms.join() !== tos.join()) return null;
  return moves;
}

/** Where `day` goes, as a full weekday name; a day that doesn't move (or names no weekday) is left as it is. */
export function moveDayName(day: string, moves: DayMoves): string {
  const weekday = normalizeDay(day);
  return (weekday && moves[weekday]) ?? day;
}

/** Each entry with its `day` moved (copied, not mutated). */
export function withDaysMoved<T extends { day: string }>(entries: T[], moves: DayMoves): T[] {
  return entries.map((entry) => ({ ...entry, day: moveDayName(entry.day, moves) }));
}

/**
 * The stored week with its days moved: each day's sessions, focus and
 * placement note go to its new day, and the weeklyStructure stays in
 * weekday order. Null if the week can't be read by weekday (an older plan's
 * "Day 1"), which only a plan update can fix.
 */
export function moveWeekDays(stored: { weeklyStructure?: unknown; sessions?: unknown }, moves: DayMoves): Week | null {
  const week = normalizeWeek(stored as Parameters<typeof normalizeWeek>[0]);
  if (!week) return null;
  const order = (day: string) => WEEKDAYS.indexOf(day as Weekday);
  return {
    weeklyStructure: withDaysMoved(week.weeklyStructure, moves).sort((x, y) => order(x.day) - order(y.day)),
    sessions: withDaysMoved(week.sessions, moves),
  };
}

/**
 * A fixed weekly session (a class the athlete or group has committed to) on
 * a day that moves, which the next update would put back on its day; it's
 * moved by changing the fixed sessions instead. Since moves only reorder
 * the week, nothing can land on a fixed day without its own day moving.
 */
export function fixedSessionMoved(
  fixedSessions: Array<{ day: string; activity: string }> | null | undefined,
  moves: DayMoves
): { day: Weekday; activity: string } | null {
  for (const s of fixedSessions ?? []) {
    const day = normalizeDay(s.day);
    if (day && moves[day]) return { day, activity: s.activity };
  }
  return null;
}
