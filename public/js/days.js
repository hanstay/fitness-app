// Weekday names — WEEKDAYS, DAY_BY_WORD and normalizeDay are duplicated by
// hand from functions/src/lib/days.ts (no build step shares that file with
// the browser); keep the two identical. Plans written since day names were
// locked use these full names; older ones can say "Mon" or "Day 1".

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Each weekday's full name and its standard abbreviations, as whole words.
const DAY_BY_WORD = new Map([
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
export function normalizeDay(raw) {
  const words = typeof raw === "string" ? raw.toLowerCase().match(/[a-z]+/g) ?? [] : [];
  const day = DAY_BY_WORD.get(words[0]);
  return day && words.every((w) => (DAY_BY_WORD.get(w) ?? day) === day) ? day : null;
}

/** Today's weekday in the athlete's own timezone (getDay() counts from Sunday). */
export function todayWeekday() {
  return WEEKDAYS[(new Date().getDay() + 6) % 7];
}
