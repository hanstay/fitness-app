import { describe, it, expect } from "vitest";
import { mergeIncrementalSessions, normalizeWeek } from "../src/lib/programMerge";
import type { SessionOutput } from "../src/lib/schemas";

function session(day: SessionOutput["day"], label: string): SessionOutput {
  return {
    day,
    label,
    focus_note: null,
    exercises: [
      { name: "Placeholder", sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null },
    ],
  };
}

describe("mergeIncrementalSessions", () => {
  it("carries every existing session forward when nothing was updated", () => {
    const existing = [session("Monday", "Lower"), session("Wednesday", "Upper")];
    const result = mergeIncrementalSessions(existing, []);
    expect(result).toEqual(existing);
  });

  it("replaces only the days present in the update, keeping the rest", () => {
    const existing = [session("Monday", "Lower v1"), session("Wednesday", "Upper v1"), session("Friday", "Full v1")];
    const updatedWed = session("Wednesday", "Upper v2");
    const result = mergeIncrementalSessions(existing, [updatedWed]);
    expect(result).toEqual([session("Monday", "Lower v1"), updatedWed, session("Friday", "Full v1")]);
  });

  it("appends a day from the update that wasn't in the existing week", () => {
    const existing = [session("Monday", "Lower v1")];
    const newDay = session("Saturday", "New Long Run");
    const result = mergeIncrementalSessions(existing, [newDay]);
    expect(result).toEqual([session("Monday", "Lower v1"), newDay]);
  });

  it("returns an empty array when both inputs are empty", () => {
    expect(mergeIncrementalSessions([], [])).toEqual([]);
  });

  it("dedups a day duplicated within updatedSessions when it's new to the existing week", () => {
    const existing = [session("Monday", "Lower v1")];
    const dup1 = session("Saturday", "Long Run v1");
    const dup2 = session("Saturday", "Long Run v2");
    const result = mergeIncrementalSessions(existing, [dup1, dup2]);
    expect(result).toEqual([session("Monday", "Lower v1"), dup2]);
  });
});

describe("normalizeWeek", () => {
  // An older plan's stored week: abbreviated, inconsistently written day names.
  const stored = (sessionDays: string[]) => ({
    weeklyStructure: [{ day: "Mon", focus: "Lower", note: null }, { day: "wed.", focus: "Upper", note: null }, { day: "SUN", focus: "Rest", note: null }],
    sessions: sessionDays.map((day) => ({ ...session("Monday", `${day} session`), day })),
  });

  it("names every day in full, keeping everything else", () => {
    expect(normalizeWeek(stored(["Mon", "Wednesday (PM)"]))).toEqual({
      weeklyStructure: [{ day: "Monday", focus: "Lower", note: null }, { day: "Wednesday", focus: "Upper", note: null }, { day: "Sunday", focus: "Rest", note: null }],
      sessions: [session("Monday", "Mon session"), session("Wednesday", "Wednesday (PM) session")],
    });
  });

  it("lets an update in full names merge into an older week by day", () => {
    const week = normalizeWeek(stored(["Mon", "wed"]))!;
    const result = mergeIncrementalSessions(week.sessions, [session("Wednesday", "Upper v2"), session("Friday", "New")]);
    expect(result).toEqual([session("Monday", "Mon session"), session("Wednesday", "Upper v2"), session("Friday", "New")]);
  });

  it("is null when any day names no weekday", () => {
    expect(normalizeWeek(stored(["Mon", "Day 2"]))).toBeNull();
    expect(normalizeWeek({ ...stored(["Mon"]), weeklyStructure: [{ day: "Day 1", focus: "Lower", note: null }] })).toBeNull();
  });

  it("treats a missing week as empty", () => {
    expect(normalizeWeek({})).toEqual({ weeklyStructure: [], sessions: [] });
  });
});
