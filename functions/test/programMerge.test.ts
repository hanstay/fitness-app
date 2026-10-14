import { describe, it, expect } from "vitest";
import { mergeIncrementalSessions, mergeUpdatedWeek, normalizeWeek } from "../src/lib/programMerge";
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

  it("keeps both sessions of a double day new to the existing week", () => {
    const existing = [session("Monday", "Lower v1")];
    const am = session("Saturday", "Long Run");
    const pm = session("Saturday", "Mobility");
    const result = mergeIncrementalSessions(existing, [am, pm]);
    expect(result).toEqual([session("Monday", "Lower v1"), am, pm]);
  });

  describe("a double day (two sessions on one weekday)", () => {
    const existing = [session("Monday", "Lift"), session("Monday", "Run"), session("Wednesday", "Upper")];

    it("is replaced as a whole by one updated session", () => {
      const result = mergeIncrementalSessions(existing, [session("Monday", "Run v2")]);
      expect(result).toEqual([session("Monday", "Run v2"), session("Wednesday", "Upper")]);
    });

    it("is replaced as a whole by two updated sessions, in place", () => {
      const result = mergeIncrementalSessions(existing, [session("Monday", "Lift v2"), session("Monday", "Run v2")]);
      expect(result).toEqual([session("Monday", "Lift v2"), session("Monday", "Run v2"), session("Wednesday", "Upper")]);
    });

    it("is kept whole when the update leaves it out", () => {
      const result = mergeIncrementalSessions(existing, [session("Wednesday", "Upper v2")]);
      expect(result).toEqual([session("Monday", "Lift"), session("Monday", "Run"), session("Wednesday", "Upper v2")]);
    });
  });
});

describe("mergeUpdatedWeek", () => {
  const existing = [session("Monday", "Upper"), session("Tuesday", "Run"), session("Wednesday", "Lower")];
  const week = (...days: Array<[SessionOutput["day"], string]>) => days.map(([day, focus]) => ({ day, focus, note: null }));

  it("drops a carried-forward session on a day the update makes a rest day", () => {
    const update = { weeklyStructure: week(["Monday", "Upper"], ["Tuesday", "Rest"], ["Wednesday", "Recovery"]), sessions: [] };
    expect(mergeUpdatedWeek(existing, update)).toEqual([session("Monday", "Upper")]);
  });

  it("keeps it when rest or recovery is only part of the day's focus", () => {
    const update = { weeklyStructure: week(["Monday", "Upper + recovery run"], ["Tuesday", "Forest trail run"], ["Wednesday", "Lower"]), sessions: [] };
    expect(mergeUpdatedWeek(existing, update)).toEqual(existing);
  });

  it("drops the old day of a session the update moved, even when it leaves that day out", () => {
    const update = {
      weeklyStructure: week(["Monday", "Upper"], ["Wednesday", "Lower"], ["Thursday", "Run"]),
      sessions: [session("Thursday", "Run")],
    };
    expect(mergeUpdatedWeek(existing, update))
      .toEqual([session("Monday", "Upper"), session("Wednesday", "Lower"), session("Thursday", "Run")]);
  });

  it("keeps every carried-forward session when the update has no weeklyStructure", () => {
    expect(mergeUpdatedWeek(existing, { weeklyStructure: [], sessions: [] })).toEqual(existing);
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

  it("merges an older \"Mon AM\"/\"Mon PM\" week with one or two updated Monday sessions", () => {
    const week = normalizeWeek(stored(["Mon AM", "Mon PM", "wed"]))!;
    expect(week.sessions.map((s) => s.day)).toEqual(["Monday", "Monday", "Wednesday"]);
    expect(mergeIncrementalSessions(week.sessions, [session("Monday", "Run v2")]))
      .toEqual([session("Monday", "Run v2"), session("Wednesday", "wed session")]);
    expect(mergeIncrementalSessions(week.sessions, [session("Monday", "Lift v2"), session("Monday", "Run v2")]))
      .toEqual([session("Monday", "Lift v2"), session("Monday", "Run v2"), session("Wednesday", "wed session")]);
  });

  it("is null when any day names no weekday", () => {
    expect(normalizeWeek(stored(["Mon", "Day 2"]))).toBeNull();
    expect(normalizeWeek({ ...stored(["Mon"]), weeklyStructure: [{ day: "Day 1", focus: "Lower", note: null }] })).toBeNull();
  });

  it("treats a missing week as empty", () => {
    expect(normalizeWeek({})).toEqual({ weeklyStructure: [], sessions: [] });
  });
});
