import { describe, it, expect } from "vitest";
import { applySessionLoads } from "../src/lib/sessionLoads";
import type { SessionOutput } from "../src/lib/schemas";

const ex = (name: string) => ({ name, sets: 1, reps: "10 min", rir: "n/a", rest_seconds: 0, load_note: null, substitution_note: null });

describe("applySessionLoads", () => {
  it("gives repeated exercise names their own load, in order", () => {
    const sessions = [{ day: "Tuesday", label: "Run", focus_note: null, exercises: [ex("Running"), ex("Squat (Barbell)"), ex("Running"), ex("Running")] }];
    const loads = [{ day: "Tuesday", exercises: [
      { name: "Running", load_note: "warm-up, zone 2" },
      { name: "Squat (Barbell)", load_note: "100kg" },
      { name: "Running", load_note: "tempo 5:00/km" },
      { name: "Running", load_note: "cool-down 6:30/km" },
    ] }];
    expect(applySessionLoads(sessions, loads)[0].exercises.map((e) => e.load_note))
      .toEqual(["warm-up, zone 2", "100kg", "tempo 5:00/km", "cool-down 6:30/km"]);
  });

  it("leaves an exercise alone when there are fewer loads than occurrences, or none for its day", () => {
    const sessions = [
      { day: "Tuesday", label: "Run", focus_note: null, exercises: [ex("Running"), ex("Running")] },
      { day: "Friday", label: "Run", focus_note: null, exercises: [ex("Running")] },
    ];
    const out = applySessionLoads(sessions, [{ day: "Tuesday", exercises: [{ name: "Running", load_note: "easy" }] }]);
    expect(out[0].exercises.map((e) => e.load_note)).toEqual(["easy", null]);
    expect(out[1].exercises[0].load_note).toBeNull();
  });

  it("gives each session of a double day its own loads, whether listed per session or together", () => {
    const sessions = [
      { day: "Monday" as const, label: "Lift", focus_note: null, exercises: [ex("Squat (Barbell)"), ex("Running")] },
      { day: "Monday" as const, label: "Run", focus_note: null, exercises: [ex("Running")] },
    ];
    const perSession = [
      { day: "Monday" as const, exercises: [{ name: "Squat (Barbell)", load_note: "100kg" }, { name: "Running", load_note: "warm-up" }] },
      { day: "Monday" as const, exercises: [{ name: "Running", load_note: "tempo" }] },
    ];
    const together = [{ day: "Monday" as const, exercises: perSession.flatMap((d) => d.exercises) }];
    for (const loads of [perSession, together]) {
      expect(applySessionLoads(sessions, loads).map((s) => s.exercises.map((e) => e.load_note)))
        .toEqual([["100kg", "warm-up"], ["tempo"]]);
    }
  });

  it("matches an older skeleton's abbreviated day to loads written in full", () => {
    const sessions = [{ day: "Tue", label: "Run", focus_note: null, exercises: [ex("Running")] }] as unknown as SessionOutput[]; // stored before day names were locked
    const out = applySessionLoads(sessions, [{ day: "Tuesday", exercises: [{ name: "Running", load_note: "easy" }] }]);
    expect(out[0]).toMatchObject({ day: "Tue", exercises: [{ load_note: "easy" }] });
  });
});
