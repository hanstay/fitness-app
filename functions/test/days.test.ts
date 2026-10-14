import { describe, it, expect } from "vitest";
import { normalizeDay } from "../src/lib/days";
import { sessionSchema } from "../src/lib/schemas";

describe("normalizeDay", () => {
  it.each([
    ["Monday", "Monday"],
    ["Mon", "Monday"],
    ["mon", "Monday"],
    ["MONDAY", "Monday"],
    ["Mon.", "Monday"],
    ["  monday ", "Monday"],
    ["Monday (AM)", "Monday"],
    ["Mo", "Monday"],
    ["Tue", "Tuesday"],
    ["Tues", "Tuesday"],
    ["Tu", "Tuesday"],
    ["Wed", "Wednesday"],
    ["Weds", "Wednesday"],
    ["Thu", "Thursday"],
    ["Thurs", "Thursday"],
    ["Th", "Thursday"],
    ["Fri", "Friday"],
    ["Sat", "Saturday"],
    ["Sun", "Sunday"],
    ["Sunday — long run", "Sunday"],
  ])("maps %j to %s", (raw, day) => {
    expect(normalizeDay(raw)).toBe(day);
  });

  it.each([["Day 1"], ["Rest"], ["T"], ["S"], [""], ["1"], ["Week 1"], [null], [undefined], [3]])(
    "can't map %j",
    (raw) => {
      expect(normalizeDay(raw)).toBeNull();
    }
  );
});

describe("day names in the program schema", () => {
  const session = (day: string) => ({ day, label: "Upper", focus_note: null, exercises: [
    { name: "Bench Press (Barbell)", sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null },
  ] });

  it("accepts a full weekday name and rejects anything else", () => {
    expect(sessionSchema.safeParse(session("Monday")).success).toBe(true);
    expect(sessionSchema.safeParse(session("Day 1")).success).toBe(false);
    expect(sessionSchema.safeParse(session("Mon")).success).toBe(false);
  });
});
