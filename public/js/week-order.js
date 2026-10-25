// The order of the week in the Program page's "Rearrange week" sheet
// (move-day.js): `order` is the weekday whose sessions each day of the week
// now holds, Monday first. No imports beyond days.js, so it's unit-tested
// from functions/test/weekOrder.test.ts.
import { WEEKDAYS } from "./days.js";

/**
 * `order` (the weekday whose sessions each day of the week now holds, Monday
 * first) after dropping the one on day `from` onto day `to`: it's taken out
 * and put back in there, and the unlocked days in between shift along one.
 */
export function dropOn(order, locked, from, to) {
  const open = WEEKDAYS.map((_, i) => i).filter((i) => !locked[i]);
  const a = open.indexOf(from), b = open.indexOf(to);
  if (a < 0 || b < 0 || a === b) return order;
  const seq = open.map((i) => order[i]);
  seq.splice(b, 0, ...seq.splice(a, 1));
  const next = order.slice();
  open.forEach((slot, k) => { next[slot] = seq[k]; });
  return next;
}

/** The moves `order` makes, as moveProgramDay takes them: { Monday: "Thursday", ... }, the days that move only. */
export const movesOf = (order) =>
  Object.fromEntries(order.map((from, i) => [from, WEEKDAYS[i]]).filter(([from, to]) => from !== to));
