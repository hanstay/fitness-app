import { describe, it, expect } from "vitest";
import {
  buildCheckinQuestions, answerGuidance, parseAmount, repRange, CheckinInput, CheckinQuestion, LoggedActivity,
} from "../src/lib/checkinQuestions";
import {
  timesWord, formatLoad, formatDistance, formatDuration, doneOfPlanned, dayOrDate, weekdayOf, shortDate,
} from "../src/lib/checkinFormat";
import type { StrengthSession } from "../src/lib/hevyDerivedData";

// 2026-10-18 is a Sunday; the plan last read the logs on Sunday 2026-10-11.
const TODAY = "2026-10-18";
const READ = "2026-10-11";
const MON = "2026-10-12", WED = "2026-10-14", THU = "2026-10-15", FRI = "2026-10-16", SAT = "2026-10-17";

const lift = (name: string, sets: number, reps: string) => ({ name, sets, reps, rir: "2", load_note: null });
const PLAN = {
  sessions: [
    { day: "Monday", label: "Lower", exercises: [lift("Squat (Barbell)", 3, "6-8"), lift("Romanian Deadlift (Barbell)", 3, "8-10")] },
    { day: "Wednesday", label: "Upper", exercises: [lift("Bench Press (Barbell)", 3, "8"), lift("Seated Row (Cable)", 3, "10-12")] },
    { day: "Saturday", label: "Long run", exercises: [{ name: "Long run, zone 2", sets: 1, reps: "14 km", rir: "n/a", load_note: null }] },
  ],
};

function hevy(date: string, exercises: Array<[string, Array<[number, number]>]>, title = "Workout"): StrengthSession {
  return {
    date, title, start_time: `${date} 18:00`, end_time: `${date} 19:00`, source: "hevy",
    exercises: exercises.map(([name, sets]) => ({
      name, sets: sets.map(([weight_kg, reps], index) => ({ index, type: "normal", weight_kg, reps, distance_km: null, duration_seconds: null, rpe: null })),
    })),
  } as StrengthSession;
}

function act(id: string, date: string, type: string, extra: Partial<LoggedActivity> = {}): LoggedActivity {
  return { id, date, type, name: null, distance_km: null, duration_s: 3000, avg_hr: null, hrZones: null, ...extra };
}

// A week that went exactly to plan.
const cleanWeek = (): CheckinInput => ({
  today: TODAY,
  planReadDate: READ,
  planSince: "2026-09-01",
  plan: PLAN,
  fixedSessions: [],
  strength: [
    hevy(MON, [["Squat (Barbell)", [[100, 7], [100, 7], [100, 6]]], ["Romanian Deadlift (Barbell)", [[80, 9], [80, 9], [80, 8]]]]),
    hevy(WED, [["Bench Press (Barbell)", [[80, 8], [80, 8], [80, 8]]], ["Seated Row (Cable)", [[60, 11], [60, 11], [60, 10]]]]),
  ],
  activities: [act("a1", SAT, "Run", { distance_km: 14.2, duration_s: 5000 })],
  tsb: -5,
  hevy: { used: true, lastSessionDate: WED, importedDate: TODAY },
  icuConnected: true,
});

const kinds = (qs: CheckinQuestion[]) => qs.map((q) => q.kind);

describe("checkinFormat", () => {
  it("writes counts, units and amounts as people say them", () => {
    expect([timesWord(1), timesWord(2), timesWord(3)]).toEqual(["once", "twice", "3 times"]);
    expect(formatLoad(80)).toBe("80 kg");
    expect(formatLoad(82.5)).toBe("82.5 kg");
    expect(formatLoad(80, "imperial")).toBe("176.4 lb");
    expect(formatDistance(8, "imperial")).toBe("5 mi");
    expect(formatDuration(3120)).toBe("52 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
  });

  it("shows both units when done and planned are measured differently", () => {
    expect(doneOfPlanned({ km: 8, seconds: 3120 }, { km: 14, seconds: null })).toBe("8 km (52 min) of 14 km");
    expect(doneOfPlanned({ km: null, seconds: 1500 }, { km: null, seconds: 3600 })).toBe("25 min of 1 h 00 min");
    expect(doneOfPlanned({ km: null, seconds: 1500 }, { km: 10, seconds: null })).toBeNull();
  });

  it("names the day only within the last week, and dates anything older", () => {
    expect(weekdayOf(TODAY)).toBe("Sunday");
    expect(dayOrDate(THU, TODAY)).toBe("Thursday");
    expect(dayOrDate("2026-10-02", TODAY)).toBe("Fri 2 Oct");
    expect(shortDate(THU)).toBe("Thu 15 Oct");
  });

  it("reads planned amounts and rep ranges", () => {
    expect(parseAmount("14 km")).toEqual({ km: 14, seconds: null });
    expect(parseAmount("30 min")).toEqual({ km: null, seconds: 1800 });
    expect(parseAmount("400 m")).toEqual({ km: 0.4, seconds: null });
    expect(repRange("6-8")).toEqual([6, 8]);
    expect(repRange("8")).toEqual([8, 8]);
    expect(repRange("AMRAP")).toBeNull();
  });
});

describe("buildCheckinQuestions", () => {
  it("asks nothing about a week that went to plan", () => {
    const q = buildCheckinQuestions(cleanWeek());
    expect(q).toEqual({ gap: null, data: [], week: [], more: [] });
  });

  it("asks about a swapped exercise, unless it was swapped on the Program page", () => {
    const input = cleanWeek();
    input.strength[0] = hevy(MON, [["Goblet Squat", [[30, 10], [30, 10], [30, 10]]], ["Romanian Deadlift (Barbell)", [[80, 9], [80, 9]]]]);
    const [q] = buildCheckinQuestions(input).week;
    expect(q.kind).toBe("swapped_exercise");
    expect(q.text).toBe("You did Goblet Squat instead of Squat (Barbell) on Monday. Why?");
    expect(q.answers.map((a) => a.label)).toEqual(["No equipment", "It hurt", "Prefer it", "Just this once"]);
    expect(answerGuidance(q, "prefer", null)).toContain("make it the plan's exercise in place of Squat (Barbell) on Monday");

    input.plan = { ...PLAN, swaps: [{ day: "Monday", from: { name: "Squat (Barbell)" }, to: { name: "Goblet Squat" } }] };
    expect(buildCheckinQuestions(input).week).toEqual([]);
  });

  it("asks a session swap when another activity replaced a planned session on the same day", () => {
    const input = cleanWeek();
    input.strength = [input.strength[0]]; // no Upper on Wednesday
    input.activities.push(act("a2", WED, "Run", { distance_km: 5, duration_s: 1600 }));
    const [q] = buildCheckinQuestions(input).week;
    expect(q.kind).toBe("swapped_session");
    expect(q.text).toBe("You did a 5 km run instead of your Upper session on Wednesday. Why?");
    const prefer = q.answers.find((a) => a.id === "prefer")!;
    expect(prefer.followUp?.answers.map((a) => a.label)).toEqual(["Yes, every Wednesday", "No, just this week"]);
    expect(answerGuidance(q, "prefer", null)).toBeNull(); // the follow-up is required
    expect(answerGuidance(q, "prefer", "yes")).toContain("move the Upper session work to another day if the week still works");
    expect(answerGuidance(q, "prefer", "no")).toBe("A one-off: keep the plan.");
  });

  it("asks a skip, not a swap, when the other activity was on a different day", () => {
    const input = cleanWeek();
    input.strength = [input.strength[0]];
    input.activities.push(act("a2", THU, "Run", { distance_km: 5, duration_s: 1600 }));
    const q = buildCheckinQuestions(input);
    expect(kinds(q.week)).toEqual(["skipped", "extra_activity"]);
    expect(q.week[0].text).toBe("Wednesday's Upper session isn't in your log. What happened?");
    expect(q.week[1].text).toBe("You added a 5 km run on Thursday. Part of your week?");
  });

  it("doesn't call a lift skipped when it's after the last Hevy import", () => {
    const input = cleanWeek();
    input.strength = [input.strength[0]]; // Wednesday's Upper not in the log...
    input.hevy = { used: true, lastSessionDate: MON, importedDate: "2026-10-13" }; // ...but the export was from Tuesday
    expect(buildCheckinQuestions(input).week).toEqual([]);
  });

  it("asks about lifts that fell short or were too easy", () => {
    const input = cleanWeek();
    input.strength[1] = hevy(WED, [["Bench Press (Barbell)", [[80, 8], [80, 6], [80, 5]]], ["Seated Row (Cable)", [[60, 14], [60, 14], [60, 15]]]]);
    const q = buildCheckinQuestions(input);
    expect(kinds(q.week)).toEqual(["fell_short", "too_easy"]);
    expect(q.week[0].text).toBe("Bench Press (Barbell) fell short of 8 reps. How did it feel?");
    expect(q.week[0].facts).toEqual(["Planned 3 × 8", "Did 80 kg × 8, 80 kg × 6, 80 kg × 5"]);
    expect(q.week[1].text).toBe("You beat every Seated Row (Cable) set. Ready for more?");
  });

  it("asks about a cut-short run with both units, and off-zone heart rate only when the data is there", () => {
    const input = cleanWeek();
    input.activities = [act("a1", SAT, "Run", { distance_km: 8, duration_s: 3120, avg_hr: 165, hrZones: [140, 150, 165, 175, 185] })];
    const q = buildCheckinQuestions(input);
    expect(kinds(q.week)).toEqual(["cut_short", "off_zone"]);
    expect(q.week[0].text).toBe("Saturday's long run was 8 km (52 min) of 14 km. Why?");
    expect(q.week[1].text).toBe("Saturday's long run averaged 165 bpm, above zone 2. How did it feel?");

    input.activities = [act("a1", SAT, "Run", { distance_km: 14, duration_s: 5000, avg_hr: 165, hrZones: null })];
    expect(buildCheckinQuestions(input).week).toEqual([]); // no zones, no question
  });

  it("asks about a missing fixed class and an added exercise", () => {
    const input = cleanWeek();
    input.fixedSessions = [{ day: "Friday", activity: "Hyrox class" }];
    input.strength[0] = hevy(MON, [["Squat (Barbell)", [[100, 7], [100, 7]]], ["Romanian Deadlift (Barbell)", [[80, 9], [80, 9]]], ["Bicep Curl (Dumbbell)", [[12, 12]]]]);
    input.strength[1] = hevy(WED, [["Bench Press (Barbell)", [[80, 8], [80, 8]]], ["Seated Row (Cable)", [[60, 11], [60, 11]]], ["Bicep Curl (Dumbbell)", [[12, 12]]]]);
    const q = buildCheckinQuestions(input);
    expect(q.week.map((x) => x.text)).toEqual([
      "No Hyrox class on Friday. What happened?",
      "You added Bicep Curl (Dumbbell) twice this week. Keep it in?",
    ]);
    // The same question keeps its key on later days, so an answer sticks.
    const old = { ...input, planReadDate: "2026-10-05" }; // so each day's window starts on a different date
    const keyOn = (today: string) => buildCheckinQuestions({ ...old, today }).week.find((x) => x.kind === "added")?.key;
    expect(keyOn("2026-10-17")).toBeDefined();
    expect(keyOn("2026-10-17")).toBe(keyOn("2026-10-18"));
  });

  it("shows 3 questions, ranked, with the rest behind Show more", () => {
    const input = cleanWeek();
    input.fixedSessions = [{ day: "Friday", activity: "Hyrox class" }];
    input.strength = [hevy(MON, [["Goblet Squat", [[30, 10], [30, 10]]], ["Romanian Deadlift (Barbell)", [[80, 5], [80, 5]]]])];
    input.activities = [act("a1", SAT, "Run", { distance_km: 8, duration_s: 3120 })];
    const q = buildCheckinQuestions(input);
    expect(q.week).toHaveLength(3);
    expect(q.week.every((x) => x.rank === 2)).toBe(true); // skip, class, cut short first
    expect(kinds(q.more).sort()).toEqual(["fell_short", "swapped_exercise"]);
  });

  it("turns a repeated miss into one pattern question", () => {
    const input = cleanWeek();
    // Wednesday missed in 3 of the last 4 weeks; Mondays all done.
    input.strength = [
      hevy(MON, [["Squat (Barbell)", [[100, 7], [100, 7]]], ["Romanian Deadlift (Barbell)", [[80, 9], [80, 9]]]]),
      hevy("2026-10-05", [["Squat (Barbell)", [[100, 7]]]]),
      hevy("2026-09-28", [["Squat (Barbell)", [[100, 7]]]]),
      hevy("2026-09-21", [["Squat (Barbell)", [[100, 7]]]]),
      hevy("2026-09-30", [["Bench Press (Barbell)", [[80, 8]]]]),
    ];
    input.activities = [act("a1", SAT, "Run", { distance_km: 14 }), act("a0", "2026-09-20", "Run", { distance_km: 14 }),
      act("b1", "2026-10-10", "Run", { distance_km: 14 }), act("b2", "2026-10-03", "Run", { distance_km: 14 }), act("b3", "2026-09-26", "Run", { distance_km: 14 })];
    const q = buildCheckinQuestions(input);
    expect(kinds(q.week)).toEqual(["pattern"]);
    expect(q.week[0].text).toBe("Wednesday's Upper session was missed in 3 of the last 4 weeks.");
    expect(answerGuidance(q.week[0], "move", "Saturday")).toContain("from Wednesday to Saturday");

    // Weeks an older plan laid out don't count.
    input.planSince = "2026-10-05";
    expect(kinds(buildCheckinQuestions(input).week)).toEqual(["skipped"]);
  });

  it("replaces several short lifts with one fatigue question when form is low", () => {
    const input = cleanWeek();
    input.tsb = -24;
    input.strength = [
      hevy(MON, [["Squat (Barbell)", [[100, 5], [100, 4]]], ["Romanian Deadlift (Barbell)", [[80, 6], [80, 6]]]]),
      input.strength[1],
    ];
    const q = buildCheckinQuestions(input);
    expect(kinds(q.week)).toEqual(["fatigue"]);
    expect(q.week[0].facts).toEqual(["Form (TSB) -24", "2 lifts short"]);
  });

  it("opens with Welcome back after a long gap, and drops skip questions", () => {
    const input = cleanWeek();
    input.planReadDate = "2026-09-20";
    input.strength = [input.strength[0]];
    const q = buildCheckinQuestions(input);
    expect(q.gap?.text).toBe("It's been 4 weeks since your plan was last updated. What happened?");
    expect(q.week).toEqual([]);
    expect(answerGuidance(q.gap!, "holiday", null)).toBe("Back after 4 weeks away on holiday: ease them back in with a lighter first week.");
  });

  it("asks about missing Hevy data instead of calling every lift skipped", () => {
    const input = cleanWeek();
    input.strength = [];
    input.hevy.lastSessionDate = "2026-10-09";
    const q = buildCheckinQuestions(input);
    expect(kinds(q.data)).toEqual(["no_new_data"]);
    expect(q.week).toEqual([]);
    expect(answerGuidance(q.data[0], "import", null)).toBeNull(); // handled on the page
  });

  it("flags a set far heavier than the athlete's best as a likely typo", () => {
    const input = cleanWeek();
    input.strength.push(hevy("2026-10-05", [["Squat (Barbell)", [[100, 6]]]]), hevy("2026-09-28", [["Squat (Barbell)", [[97.5, 6]]]]));
    input.strength[0] = hevy(MON, [["Squat (Barbell)", [[100, 7], [1000, 7]]], ["Romanian Deadlift (Barbell)", [[80, 9], [80, 9]]]]);
    const q = buildCheckinQuestions(input);
    expect(q.data.map((x) => x.text)).toEqual(["Squat (Barbell): 1000 kg × 7? That's far more than your best of 100 kg."]);
  });

  it("doesn't ask about today's session before the day is over", () => {
    const input = cleanWeek();
    input.today = "2026-10-19"; // Monday, Lower not logged yet
    input.planReadDate = "2026-10-12";
    input.strength = [input.strength[1]];
    input.hevy = { used: true, lastSessionDate: WED, importedDate: "2026-10-19" };
    expect(buildCheckinQuestions(input).week.filter((x) => x.kind === "skipped")).toEqual([]);
  });
});
