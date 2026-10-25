import { describe, it, expect } from "vitest";
import { moveDayName, withDaysMoved, moveWeekDays, fixedSessionMoved, readMoves, swapMoves } from "../src/lib/moveDay";

const ex = (name: string) => ({ name, sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null });
const day = (d: string, focus: string, note: string | null = null) => ({ day: d, focus, note });
const stored = () => ({
  weeklyStructure: [
    day("Monday", "Lower"), day("Tuesday", "Rest"), day("Wednesday", "Upper", "After a rest day"), day("Thursday", "Rest"),
    day("Friday", "Run"), day("Saturday", "Rest"), day("Sunday", "Rest"),
  ],
  sessions: [
    { day: "Monday", label: "Lower", focus_note: null, exercises: [ex("Squat (Barbell)")] },
    { day: "Wednesday", label: "Upper", focus_note: null, exercises: [ex("Bench Press (Barbell)")] },
    { day: "Friday", label: "Run AM", focus_note: null, exercises: [ex("Easy run")] },
    { day: "Friday", label: "Mobility PM", focus_note: null, exercises: [ex("Hip mobility")] },
  ],
});

describe("readMoves", () => {
  it("reads a new order for the week, dropping days that stay put", () => {
    // Monday's session to Thursday, Tuesday to Thursday shifting up a day.
    expect(readMoves({ Monday: "Thursday", Tuesday: "Monday", Wednesday: "Tuesday", Thursday: "Wednesday", Friday: "Friday" }))
      .toEqual({ Monday: "Thursday", Tuesday: "Monday", Wednesday: "Tuesday", Thursday: "Wednesday" });
    expect(readMoves(swapMoves("Monday", "Friday"))).toEqual({ Monday: "Friday", Friday: "Monday" });
  });

  it("refuses anything that isn't a reordering of the week", () => {
    expect(readMoves({ Monday: "Friday" })).toBeNull(); // Friday's sessions would land on Monday's too
    expect(readMoves({ Monday: "Friday", Tuesday: "Friday", Friday: "Monday" })).toBeNull();
    expect(readMoves({ Monday: "Fri", Fri: "Monday" })).toBeNull();
    expect(readMoves({ Monday: "Monday" })).toBeNull();
    expect(readMoves({})).toBeNull();
    expect(readMoves(["Monday", "Friday"])).toBeNull();
    expect(readMoves("Monday")).toBeNull();
    expect(readMoves(null)).toBeNull();
  });
});

describe("moveDayName", () => {
  it("moves a day, as a full weekday name, and leaves the rest", () => {
    const moves = swapMoves("Monday", "Friday");
    expect(moveDayName("Monday", moves)).toBe("Friday");
    expect(moveDayName("fri", moves)).toBe("Monday");
    expect(moveDayName("Tue", moves)).toBe("Tue");
    expect(moveDayName("Day 1", moves)).toBe("Day 1");
  });
});

describe("moveWeekDays", () => {
  it("swaps two training days' sessions, focus and note, keeping the week in order", () => {
    const week = moveWeekDays(stored(), swapMoves("Wednesday", "Friday"))!;
    expect(week.weeklyStructure.map((d) => `${d.day}:${d.focus}`)).toEqual([
      "Monday:Lower", "Tuesday:Rest", "Wednesday:Run", "Thursday:Rest", "Friday:Upper", "Saturday:Rest", "Sunday:Rest",
    ]);
    expect(week.weeklyStructure[4].note).toBe("After a rest day");
    expect(week.sessions.map((s) => `${s.day}:${s.label}`)).toEqual(["Monday:Lower", "Friday:Upper", "Wednesday:Run AM", "Wednesday:Mobility PM"]);
  });

  it("moves a session several days on, shifting the days in between", () => {
    const week = moveWeekDays(stored(), { Monday: "Thursday", Tuesday: "Monday", Wednesday: "Tuesday", Thursday: "Wednesday" })!;
    expect(week.weeklyStructure.map((d) => `${d.day}:${d.focus}`)).toEqual([
      "Monday:Rest", "Tuesday:Upper", "Wednesday:Rest", "Thursday:Lower", "Friday:Run", "Saturday:Rest", "Sunday:Rest",
    ]);
    expect(week.sessions.map((s) => `${s.day}:${s.label}`)).toEqual(["Thursday:Lower", "Tuesday:Upper", "Friday:Run AM", "Friday:Mobility PM"]);
  });

  it("moves a training day onto a rest day", () => {
    const week = moveWeekDays(stored(), swapMoves("Monday", "Tuesday"))!;
    expect(week.weeklyStructure.slice(0, 2).map((d) => `${d.day}:${d.focus}`)).toEqual(["Monday:Rest", "Tuesday:Lower"]);
    expect(week.sessions[0].day).toBe("Tuesday");
  });

  it("reads an older plan's abbreviated days, and refuses one that names no weekday", () => {
    const old = stored();
    old.sessions[0].day = "Mon";
    old.weeklyStructure[0].day = "mon";
    const week = moveWeekDays(old, swapMoves("Monday", "Sunday"))!;
    expect(week.sessions[0].day).toBe("Sunday");
    expect(week.weeklyStructure.at(-1)).toMatchObject({ day: "Sunday", focus: "Lower" });

    old.sessions[1].day = "Day 2";
    expect(moveWeekDays(old, swapMoves("Monday", "Sunday"))).toBeNull();
  });

  it("doesn't change the stored week", () => {
    const before = stored();
    moveWeekDays(before, swapMoves("Monday", "Friday"));
    expect(before).toEqual(stored());
  });
});

describe("withDaysMoved", () => {
  it("moves a group member's loads with their days", () => {
    const loads = [{ day: "Monday", exercises: [{ name: "Squat (Barbell)", load_note: "5 × 80 kg" }] }, { day: "Friday", exercises: [] }];
    expect(withDaysMoved(loads, swapMoves("Monday", "Friday")).map((l) => l.day)).toEqual(["Friday", "Monday"]);
  });
});

describe("fixedSessionMoved", () => {
  it("finds a fixed session on a day that moves, however its day is written", () => {
    const fixed = [{ day: "Tue", activity: "Hyrox class" }];
    expect(fixedSessionMoved(fixed, swapMoves("Monday", "Tuesday"))).toEqual({ day: "Tuesday", activity: "Hyrox class" });
    expect(fixedSessionMoved(fixed, { Monday: "Wednesday", Wednesday: "Monday" })).toBeNull();
    expect(fixedSessionMoved(undefined, swapMoves("Monday", "Friday"))).toBeNull();
  });
});
