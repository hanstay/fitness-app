import { describe, it, expect } from "vitest";
import { buildCheckinQuestions, answerGuidance, planHasLifts, CheckinInput, CheckinQuestion } from "../src/lib/checkinQuestions";
import { dayOrDate, weekdayOf, shortDate } from "../src/lib/checkinFormat";

// 2026-10-18 is a Sunday; the plan last read the logs on Sunday 2026-10-11.
const TODAY = "2026-10-18";
const READ = "2026-10-11";

const input = (o: Partial<CheckinInput> = {}): CheckinInput => ({
  today: TODAY,
  planReadDate: READ,
  planHasLifts: true,
  hevy: { used: true, lastSessionDate: "2026-10-16" },
  ...o,
});

const kinds = (qs: CheckinQuestion[]) => qs.map((q) => q.kind);

describe("checkinFormat", () => {
  it("names the day only within the last week, and dates anything older", () => {
    expect(weekdayOf(TODAY)).toBe("Sunday");
    expect(dayOrDate("2026-10-15", TODAY)).toBe("Thursday");
    expect(dayOrDate("2026-10-02", TODAY)).toBe("Fri 2 Oct");
    expect(shortDate("2026-10-15")).toBe("Thu 15 Oct");
  });
});

describe("planHasLifts", () => {
  it("counts lifts, not rest or conditioning", () => {
    const lift = { name: "Squat (Barbell)", reps: "6-8", rir: "2" };
    expect(planHasLifts([{ exercises: [lift] }])).toBe(true);
    expect(planHasLifts([{ exercises: [{ name: "Long run, zone 2", reps: "14 km", rir: "n/a" }, { name: "Rest" }] }])).toBe(false);
    expect(planHasLifts([{ exercises: [{ name: "Bike", reps: "30 min", rir: "" }] }])).toBe(false);
    expect(planHasLifts(null)).toBe(false);
  });
});

describe("buildCheckinQuestions", () => {
  it("asks nothing when Hevy has new workouts and the plan is recent", () => {
    expect(buildCheckinQuestions(input())).toEqual([]);
  });

  it("asks nothing without a plan", () => {
    expect(buildCheckinQuestions(input({ planReadDate: null, hevy: { used: true, lastSessionDate: null } }))).toEqual([]);
  });

  it("opens with Welcome back after a long gap", () => {
    const [q] = buildCheckinQuestions(input({ planReadDate: "2026-09-20", hevy: { used: true, lastSessionDate: "2026-10-16" } }));
    expect(q.kind).toBe("long_gap");
    expect(q.text).toBe("It's been 4 weeks since your plan was last updated. What happened?");
    expect(q.answers.find((a) => a.id === "injured")?.details).toBe(true);
    expect(answerGuidance(q, "holiday")).toBe("Back after 4 weeks away on holiday: ease them back in with a lighter first week.");
    expect(answerGuidance(q, "made-up")).toBeNull();
  });

  it("asks about missing Hevy data once a few days have passed with nothing new", () => {
    const qs = buildCheckinQuestions(input({ hevy: { used: true, lastSessionDate: "2026-10-09" } }));
    expect(kinds(qs)).toEqual(["no_new_data"]);
    expect(qs[0].text).toBe("No new Hevy workouts since Sun 11 Oct, when your plan was last updated.");
    expect(answerGuidance(qs[0], "import")).toBeNull(); // handled on the page
    expect(answerGuidance(qs[0], "rest")).toContain("treat it as a rest week");
    // Too soon after the update to call it stale.
    expect(buildCheckinQuestions(input({ today: "2026-10-13", hevy: { used: true, lastSessionDate: "2026-10-09" } }))).toEqual([]);
  });

  it("doesn't ask about Hevy when it isn't used or the plan has no lifts", () => {
    expect(buildCheckinQuestions(input({ hevy: { used: false, lastSessionDate: null } }))).toEqual([]);
    expect(buildCheckinQuestions(input({ planHasLifts: false, hevy: { used: true, lastSessionDate: "2026-10-01" } }))).toEqual([]);
  });

  it("asks both after a long gap with nothing new from Hevy, welcome back first", () => {
    const qs = buildCheckinQuestions(input({ planReadDate: "2026-09-20", hevy: { used: true, lastSessionDate: "2026-09-18" } }));
    expect(kinds(qs)).toEqual(["long_gap", "no_new_data"]);
  });
});
