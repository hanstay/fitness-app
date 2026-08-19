import { describe, it, expect } from "vitest";
import { mergeIncrementalSessions } from "../src/lib/programMerge";
import type { SessionOutput } from "../src/lib/schemas";

function session(day: string, label: string): SessionOutput {
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
    const existing = [session("Mon", "Lower"), session("Wed", "Upper")];
    const result = mergeIncrementalSessions(existing, []);
    expect(result).toEqual(existing);
  });

  it("replaces only the days present in the update, keeping the rest", () => {
    const existing = [session("Mon", "Lower v1"), session("Wed", "Upper v1"), session("Fri", "Full v1")];
    const updatedWed = session("Wed", "Upper v2");
    const result = mergeIncrementalSessions(existing, [updatedWed]);
    expect(result).toEqual([session("Mon", "Lower v1"), updatedWed, session("Fri", "Full v1")]);
  });

  it("appends a day from the update that wasn't in the existing week", () => {
    const existing = [session("Mon", "Lower v1")];
    const newDay = session("Sat", "New Long Run");
    const result = mergeIncrementalSessions(existing, [newDay]);
    expect(result).toEqual([session("Mon", "Lower v1"), newDay]);
  });

  it("returns an empty array when both inputs are empty", () => {
    expect(mergeIncrementalSessions([], [])).toEqual([]);
  });
});
