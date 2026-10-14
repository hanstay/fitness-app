import { ProgramOutput, SessionOutput } from "./schemas";
import { normalizeDay, Weekday } from "./days";

// weeklyStructure covers all 7 days including rest days, but `sessions` only
// covers training days -- so this merges by the union of days present in
// existingSessions/updatedSessions rather than cross-referencing
// weeklyStructure (which would demand a session for every rest day too).
// A day can hold more than one session (e.g. a lift AM and a run PM), so a
// day is replaced as a whole: every existing session on a day the update
// covers gives way to all of the update's sessions for it, in its place in
// the week; days the update leaves out are kept, and new days are appended.
export function mergeIncrementalSessions(
  existingSessions: SessionOutput[],
  updatedSessions: SessionOutput[]
): SessionOutput[] {
  const updatedFor = (day: string) => updatedSessions.filter((s) => s.day === day);
  const placed = new Set<string>();
  const merged: SessionOutput[] = [];

  for (const s of [...existingSessions, ...updatedSessions]) {
    const updated = updatedFor(s.day);
    if (updated.length === 0) merged.push(s);
    else if (!placed.has(s.day)) merged.push(...updated);
    placed.add(s.day);
  }

  return merged;
}

type StoredDay = { day?: unknown };

function withWeekdays<T extends StoredDay>(entries: T[] | null | undefined): Array<T & { day: Weekday }> | null {
  const out: Array<T & { day: Weekday }> = [];
  for (const entry of entries ?? []) {
    const day = normalizeDay(entry.day);
    if (!day) return null;
    out.push({ ...entry, day });
  }
  return out;
}

/**
 * A stored program's week with every day as a full weekday name — plans
 * saved before day names were locked can say "Mon" — so it merges by day
 * with an update written in full names. Null if any day names no weekday
 * ("Day 1"): that week can't be merged, so the update rebuilds it instead
 * (see decideRegen in programDecisions.ts).
 */
export function normalizeWeek(program: {
  weeklyStructure?: StoredDay[] | null;
  sessions?: StoredDay[] | null;
}): Pick<ProgramOutput, "weeklyStructure" | "sessions"> | null {
  const weeklyStructure = withWeekdays(program.weeklyStructure);
  const sessions = withWeekdays(program.sessions);
  // Only the day names are checked here; the rest of a stored week is as
  // trusted as before (the merged program is validated against programSchema).
  return weeklyStructure && sessions ? { weeklyStructure, sessions } as Pick<ProgramOutput, "weeklyStructure" | "sessions"> : null;
}
