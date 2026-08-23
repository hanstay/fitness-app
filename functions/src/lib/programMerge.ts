import { SessionOutput } from "./schemas";

// weeklyStructure covers all 7 days including rest days, but `sessions` only
// covers training days -- so this merges by the union of days present in
// existingSessions/updatedSessions rather than cross-referencing
// weeklyStructure (which would demand a session for every rest day too).
export function mergeIncrementalSessions(
  existingSessions: SessionOutput[],
  updatedSessions: SessionOutput[]
): SessionOutput[] {
  const updatedByDay = new Map(updatedSessions.map((s) => [s.day, s]));
  const existingByDay = new Map(existingSessions.map((s) => [s.day, s]));

  const merged = existingSessions.map((s) => updatedByDay.get(s.day) ?? s);

  for (const s of updatedByDay.values()) {
    if (!existingByDay.has(s.day)) merged.push(s);
  }

  return merged;
}
