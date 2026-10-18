import { describe, it, expect } from "vitest";
import { swapDayName, withDaysSwapped, moveWeekDays, fixedSessionOn } from "../src/lib/moveDay";

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

describe("swapDayName", () => {
  it("swaps the two days, as full weekday names, and leaves the rest", () => {
    expect(swapDayName("Monday", "Monday", "Friday")).toBe("Friday");
    expect(swapDayName("fri", "Monday", "Friday")).toBe("Monday");
    expect(swapDayName("Tue", "Monday", "Friday")).toBe("Tue");
    expect(swapDayName("Day 1", "Monday", "Friday")).toBe("Day 1");
  });
});

describe("moveWeekDays", () => {
  it("swaps two training days' sessions, focus and note, keeping the week in order", () => {
    const week = moveWeekDays(stored(), "Wednesday", "Friday")!;
    expect(week.weeklyStructure.map((d) => `${d.day}:${d.focus}`)).toEqual([
      "Monday:Lower", "Tuesday:Rest", "Wednesday:Run", "Thursday:Rest", "Friday:Upper", "Saturday:Rest", "Sunday:Rest",
    ]);
    expect(week.weeklyStructure[4].note).toBe("After a rest day");
    expect(week.sessions.map((s) => `${s.day}:${s.label}`)).toEqual(["Monday:Lower", "Friday:Upper", "Wednesday:Run AM", "Wednesday:Mobility PM"]);
  });

  it("moves a training day onto a rest day", () => {
    const week = moveWeekDays(stored(), "Monday", "Tuesday")!;
    expect(week.weeklyStructure.slice(0, 2).map((d) => `${d.day}:${d.focus}`)).toEqual(["Monday:Rest", "Tuesday:Lower"]);
    expect(week.sessions[0].day).toBe("Tuesday");
  });

  it("reads an older plan's abbreviated days, and refuses one that names no weekday", () => {
    const old = stored();
    old.sessions[0].day = "Mon";
    old.weeklyStructure[0].day = "mon";
    const week = moveWeekDays(old, "Monday", "Sunday")!;
    expect(week.sessions[0].day).toBe("Sunday");
    expect(week.weeklyStructure.at(-1)).toMatchObject({ day: "Sunday", focus: "Lower" });

    old.sessions[1].day = "Day 2";
    expect(moveWeekDays(old, "Monday", "Sunday")).toBeNull();
  });

  it("doesn't change the stored week", () => {
    const before = stored();
    moveWeekDays(before, "Monday", "Friday");
    expect(before).toEqual(stored());
  });
});

describe("withDaysSwapped", () => {
  it("moves a group member's loads with their days", () => {
    const loads = [{ day: "Monday", exercises: [{ name: "Squat (Barbell)", load_note: "5 × 80 kg" }] }, { day: "Friday", exercises: [] }];
    expect(withDaysSwapped(loads, "Monday", "Friday").map((l) => l.day)).toEqual(["Friday", "Monday"]);
  });
});

describe("fixedSessionOn", () => {
  it("finds a fixed session on either day, however its day is written", () => {
    const fixed = [{ day: "Tue", activity: "Hyrox class" }];
    expect(fixedSessionOn(fixed, "Monday", "Tuesday")).toEqual({ day: "Tuesday", activity: "Hyrox class" });
    expect(fixedSessionOn(fixed, "Monday", "Friday")).toBeNull();
    expect(fixedSessionOn(undefined, "Monday", "Friday")).toBeNull();
  });
});
