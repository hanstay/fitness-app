// Small date and count helpers for the check-in's questions (see
// checkinQuestions.ts): a day name only for this week, a short date before
// that. Pure, no Firebase imports.
import { WEEKDAYS, Weekday } from "./days";

const DAY_MS = 86400000;

/** "1 week", "4 weeks". */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The weekday of a YYYY-MM-DD date. */
export function weekdayOf(date: string): Weekday {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7];
}

export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS);
}

const SHORT_DAY: Record<Weekday, string> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Thursday" for a date in the last 6 days, so a day name never means two
 * dates; "Thu 2 Oct" for anything older.
 */
export function dayOrDate(date: string, today: string): string {
  return daysBetween(date, today) < 7 ? weekdayOf(date) : shortDate(date);
}

/** "Thu 2 Oct". */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${SHORT_DAY[weekdayOf(date)]} ${d} ${MONTHS[m - 1]}`;
}
