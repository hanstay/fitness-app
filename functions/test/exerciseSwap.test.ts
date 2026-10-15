import { describe, it, expect } from "vitest";
import {
  locateExercise, settleSwapsForUpdate, swapsStillInWeek, formatSwapsBlock, freshOptions, applySwap, undoSwap,
  toExercise, SwapRecord, SwapOption,
} from "../src/lib/exerciseSwap";
import type { SessionOutput } from "../src/lib/schemas";

const ex = (name: string) => ({ name, sets: 3, reps: "8", rir: "2", rest_seconds: 90, load_note: null, substitution_note: null });
const week = (): SessionOutput[] => [
  { day: "Monday", label: "Lower", focus_note: null, exercises: [ex("Squat (Barbell)"), ex("Walking Lunge (Dumbbell)")] },
  { day: "Wednesday", label: "Upper", focus_note: null, exercises: [ex("Bench Press (Barbell)")] },
];
const option = (name: string): SwapOption => ({ name, why: "", sets: 3, reps: "10", rir: "2", rest_seconds: 60, load_note: null });
const meta = (over: Partial<SwapRecord> = {}) => ({ id: "s1", reason: "dislike" as const, scope: "this_week" as const, noteId: null, createdAt: "2026-10-15T00:00:00Z", ...over });

describe("locateExercise", () => {
  it("uses the hint when it still matches, else searches the day", () => {
    expect(locateExercise(week(), "Monday", "Walking Lunge (Dumbbell)", { sessionIndex: 0, exerciseIndex: 1 })).toEqual({ sessionIndex: 0, exerciseIndex: 1 });
    expect(locateExercise(week(), "Monday", "Walking Lunge (Dumbbell)", { sessionIndex: 0, exerciseIndex: 0 })).toEqual({ sessionIndex: 0, exerciseIndex: 1 });
    expect(locateExercise(week(), "Wednesday", "Squat (Barbell)")).toBeNull();
  });

  it("matches an older plan's abbreviated day names as weekdays", () => {
    const old = week().map((s) => ({ ...s, day: s.day.slice(0, 3) })) as unknown as SessionOutput[];
    expect(locateExercise(old, "Monday", "Walking Lunge (Dumbbell)")).toEqual({ sessionIndex: 0, exerciseIndex: 1 });
    const a = applySwap(old, [], { sessionIndex: 0, exerciseIndex: 1 }, ex("Box Step-Up (Dumbbell)"), meta());
    expect(a.record.day).toBe("Monday");
  });
});

describe("applySwap and undoSwap", () => {
  it("swaps and undoes back to the original", () => {
    const a = applySwap(week(), [], { sessionIndex: 0, exerciseIndex: 1 }, toExercise(option("Box Step-Up (Dumbbell)")), meta());
    expect(a.sessions[0].exercises[1].name).toBe("Box Step-Up (Dumbbell)");
    expect(a.record).toMatchObject({ day: "Monday", from: { name: "Walking Lunge (Dumbbell)" }, to: { name: "Box Step-Up (Dumbbell)" } });
    const u = undoSwap(a.sessions, a.swaps, "s1");
    expect(u?.sessions).toEqual(week());
    expect(u?.swaps).toEqual([]);
  });

  it("folds a swap of a swapped-in exercise into the first, keeping its note", () => {
    const a = applySwap(week(), [], { sessionIndex: 0, exerciseIndex: 1 }, ex("Box Step-Up (Dumbbell)"), meta({ noteId: "n1" }));
    const b = applySwap(a.sessions, a.swaps, { sessionIndex: 0, exerciseIndex: 1 }, ex("Leg Press (Machine)"), meta({ id: "s2" }));
    expect(b.swaps).toHaveLength(1);
    expect(b.record).toMatchObject({ id: "s2", noteId: "n1", from: { name: "Walking Lunge (Dumbbell)" }, to: { name: "Leg Press (Machine)" } });
    expect(undoSwap(b.sessions, b.swaps, "s2")?.sessions).toEqual(week());
  });

  it("can't undo an unknown swap or one whose exercise is gone", () => {
    const a = applySwap(week(), [], { sessionIndex: 1, exerciseIndex: 0 }, ex("Push-Up"), meta());
    expect(undoSwap(a.sessions, a.swaps, "nope")).toBeNull();
    expect(undoSwap(week(), a.swaps, "s1")).toBeNull();
  });
});

describe("settleSwapsForUpdate", () => {
  const swapped = (m: Partial<SwapRecord>) => applySwap(week(), [], { sessionIndex: 0, exerciseIndex: 1 }, ex("Box Step-Up (Dumbbell)"), meta(m));

  it("puts a this-week swap back", () => {
    const a = swapped({});
    const r = settleSwapsForUpdate(a.sessions, a.swaps, new Set());
    expect(r.sessions).toEqual(week());
    expect(r.kept).toEqual([]);
  });

  it("keeps a this-week swap while its pain note is still being worked around", () => {
    const a = swapped({ noteId: "n1", reason: "hurts" });
    expect(settleSwapsForUpdate(a.sessions, a.swaps, new Set(["n1"])).kept).toHaveLength(1);
    expect(settleSwapsForUpdate(a.sessions, a.swaps, new Set()).kept).toHaveLength(0);
  });

  it("keeps a rest-of-block swap and drops one whose exercise is gone", () => {
    const a = swapped({ scope: "rest_of_block" });
    expect(settleSwapsForUpdate(a.sessions, a.swaps, new Set()).kept).toHaveLength(1);
    expect(settleSwapsForUpdate(week(), a.swaps, new Set()).kept).toHaveLength(0);
  });

  it("follows a kept swap to where the new week has it", () => {
    const a = swapped({ scope: "rest_of_block" });
    const moved: SessionOutput[] = [{ ...a.sessions[0], exercises: [ex("Box Step-Up (Dumbbell)"), ex("Squat (Barbell)")] }];
    expect(swapsStillInWeek(moved, a.swaps)[0]).toMatchObject({ sessionIndex: 0, exerciseIndex: 0 });
    expect(swapsStillInWeek(week(), a.swaps)).toEqual([]);
  });
});

describe("freshOptions", () => {
  it("drops options the day already has and repeats", () => {
    const r = freshOptions([option("squat (barbell)"), option("Leg Press (Machine)"), option("Leg Press (Machine) ")], ["Squat (Barbell)"]);
    expect(r.map((o) => o.name)).toEqual(["Leg Press (Machine)"]);
  });
});

describe("formatSwapsBlock", () => {
  it("lists swaps for the update, or nothing", () => {
    const a = applySwap(week(), [], { sessionIndex: 0, exerciseIndex: 1 }, ex("Box Step-Up (Dumbbell)"), meta({ reason: "hurts" }));
    expect(formatSwapsBlock(a.swaps)).toContain('- Monday: "Walking Lunge (Dumbbell)" → "Box Step-Up (Dumbbell)" (it hurts)');
    expect(formatSwapsBlock([])).toBe("");
  });
});
