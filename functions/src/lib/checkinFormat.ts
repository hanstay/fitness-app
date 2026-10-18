// The small formatters that fill a check-in question's blanks (see
// checkinQuestions.ts): counts read as words people say, loads and distances
// in the athlete's units, done-vs-planned with both units when they differ,
// and a day name only for this week. Pure, no Firebase imports.
import { WEEKDAYS, Weekday } from "./days";

export type Units = "metric" | "imperial";

const DAY_MS = 86400000;
const KG_PER_LB = 0.45359237;
const KM_PER_MI = 1.609344;

const trim = (n: number, digits = 1): string => String(Math.round(n * 10 ** digits) / 10 ** digits);

/** "once", "twice", "3 times". */
export function timesWord(count: number): string {
  if (count === 1) return "once";
  if (count === 2) return "twice";
  return `${count} times`;
}

/** "1 week", "4 weeks". */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "80 kg" or "176.4 lb". */
export function formatLoad(kg: number, units: Units = "metric"): string {
  return units === "imperial" ? `${trim(kg / KG_PER_LB)} lb` : `${trim(kg, 2)} kg`;
}

/** "8 km" or "5 mi". */
export function formatDistance(km: number, units: Units = "metric"): string {
  return units === "imperial" ? `${trim(km / KM_PER_MI)} mi` : `${trim(km)} km`;
}

/** "52 min", "1 h 05 min". */
export function formatDuration(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

/** A planned amount: a distance, a time, or both. */
export interface Amount {
  km: number | null;
  seconds: number | null;
}

/**
 * What was done against what was planned, in the plan's own measure. When
 * the plan names a distance and the log has a time too, the time is shown
 * alongside, and the other way round: "8 km (52 min) of 14 km".
 */
export function doneOfPlanned(done: Amount, planned: Amount, units: Units = "metric"): string | null {
  if (planned.km != null && done.km != null) {
    const extra = done.seconds != null ? ` (${formatDuration(done.seconds)})` : "";
    return `${formatDistance(done.km, units)}${extra} of ${formatDistance(planned.km, units)}`;
  }
  if (planned.seconds != null && done.seconds != null) {
    const extra = done.km != null ? ` (${formatDistance(done.km, units)})` : "";
    return `${formatDuration(done.seconds)}${extra} of ${formatDuration(planned.seconds)}`;
  }
  return null;
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

/** "Thursday's" / "Thu 2 Oct's". */
export const possessive = (s: string): string => `${s}'s`;
