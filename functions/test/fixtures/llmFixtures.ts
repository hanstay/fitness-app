// Canned, schema-valid stand-ins for every Claude call the app makes, keyed
// by the same toolName every extractStructuredJson call site already passes.
// Shapes are informed by real captured output (group cySVvxQLjRe23FSODXi7's
// Hyrox Doubles program, and the personal-program generations logged during
// earlier testing), kept compact rather than verbatim. See
// docs/plans/llm-fixture-testing.md for why this boundary is mocked instead
// of the Anthropic SDK.
import {
  programOverviewSchema, programScheduleSchema, programUpdateSchema,
  programSharedSchema, memberLayerSchema, mealPlanSchema, bodyScanExtractionSchema,
} from "../../src/lib/schemas";

const exercise = (name: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  name, sets: 4, reps: "6-8", rir: "2", rest_seconds: 120, load_note: null, substitution_note: null,
  ...overrides,
});

export const FIXTURES: Record<string, unknown> = {
  record_program_overview: {
    title: "Hybrid Strength Base",
    goalSummary: "Build a strength base while maintaining aerobic fitness.",
    currentState: {
      summary: "Squat and bench holding steady; CTL trending up.",
      trainingLoad: { ctl: 32, atl: 30, tsb: 2 },
      highlights: ["Squat e1RM flat at 100kg", "3 runs logged this week"],
    },
    events: [{ name: "Spring 10k", date: "2027-04-01", weeksOut: "~20 weeks", goal: "Finish comfortably under 55 minutes." }],
    roadmap: [
      { phase: "Base", dates: "Weeks 1-6", focus: "Build strength + aerobic base", lifting: "Upper/Lower, moderate volume", running: "2 easy runs/week", nutrition: "Maintenance calories" },
    ],
    progressionRules: "Add load when reps and RIR targets are hit for two sessions running.",
    deloadGuidance: "Deload volume ~40% every 6th week.",
    warmupNotes: "5-10 min general warm-up, then ramping sets on the first lift.",
    coachNotes: null,
    sportNotes: null,
    nutritionNote: null,
  },
  record_program_schedule: {
    split: "Upper/Lower",
    daysPerWeek: 4,
    weeklyStructure: [
      { day: "Monday", focus: "Upper", note: null },
      { day: "Tuesday", focus: "Lower", note: null },
      { day: "Wednesday", focus: "Rest", note: null },
      { day: "Thursday", focus: "Upper", note: null },
      { day: "Friday", focus: "Lower", note: null },
      { day: "Saturday", focus: "Rest", note: null },
      { day: "Sunday", focus: "Rest", note: null },
    ],
    sessions: [
      { day: "Monday", label: "Upper", focus_note: null, exercises: [exercise("Bench Press"), exercise("Barbell Row")] },
      { day: "Tuesday", label: "Lower", focus_note: null, exercises: [exercise("Back Squat"), exercise("Romanian Deadlift")] },
      { day: "Thursday", label: "Upper", focus_note: null, exercises: [exercise("Overhead Press"), exercise("Pull-up")] },
      { day: "Friday", label: "Lower", focus_note: null, exercises: [exercise("Front Squat"), exercise("Leg Curl")] },
    ],
    running: null,
  },
  record_program_update: {
    currentState: {
      summary: "Strength holding, adherence good.",
      trainingLoad: { ctl: 34, atl: 31, tsb: 3 },
      highlights: ["Bench e1RM up 2%"],
    },
    weeklyStructure: [
      { day: "Monday", focus: "Upper", note: null },
      { day: "Tuesday", focus: "Lower", note: null },
      { day: "Wednesday", focus: "Rest", note: null },
      { day: "Thursday", focus: "Upper", note: null },
      { day: "Friday", focus: "Lower", note: null },
      { day: "Saturday", focus: "Rest", note: null },
      { day: "Sunday", focus: "Rest", note: null },
    ],
    sessions: [
      { day: "Monday", label: "Upper", focus_note: null, exercises: [exercise("Bench Press", { load_note: "+2.5kg" })] },
    ],
    changeSummary: ["Bench press +2.5kg — e1RM trending up."],
    coachNotes: null,
    nutritionNote: null,
    running: null,
  },
  record_group_program: {
    title: "Hyrox Doubles + Endurance Build",
    goalSummary: "Prepare both athletes for Hyrox Doubles with shared strength and conditioning sessions.",
    split: "Hybrid",
    daysPerWeek: 6,
    events: [{ name: "Hyrox Men's Doubles", date: "2026-11-29", weeksOut: "~1 week", goal: "Complete doubles race with strong transitions." }],
    roadmap: [
      { phase: "Base", dates: "Weeks 1-8", focus: "Build strength + Hyrox conditioning", lifting: "Full-body, moderate volume", running: "2 zone-2 runs/week", nutrition: "Maintenance" },
    ],
    weeklyStructure: [
      { day: "Monday", focus: "Strength", note: null },
      { day: "Tuesday", focus: "Conditioning", note: null },
      { day: "Wednesday", focus: "HIIT Class", note: "Fixed session" },
      { day: "Thursday", focus: "Strength", note: null },
      { day: "Friday", focus: "Hyrox Class", note: "Fixed session" },
      { day: "Saturday", focus: "Long conditioning", note: null },
      { day: "Sunday", focus: "Rest", note: null },
    ],
    sessions: [
      { day: "Monday", label: "Strength", focus_note: null, exercises: [exercise("Back Squat"), exercise("Sled Push")] },
      { day: "Tuesday", label: "Conditioning", focus_note: null, exercises: [exercise("Row Intervals", { reps: "8x250m", rir: "n/a" })] },
      { day: "Wednesday", label: "HIIT Class", focus_note: null, exercises: [exercise("HIIT Class", { reps: "45 min", rir: "n/a" })] },
      { day: "Thursday", label: "Strength", focus_note: null, exercises: [exercise("Deadlift"), exercise("Wall Ball")] },
      { day: "Friday", label: "Hyrox Class", focus_note: null, exercises: [exercise("Hyrox Class", { reps: "60 min", rir: "n/a" })] },
      { day: "Saturday", label: "Long conditioning", focus_note: null, exercises: [exercise("Farmers Carry")] },
    ],
    running: { pacesNote: "Easy runs conversational pace.", sessions: [{ name: "Zone-2 run", detail: "30-40 min easy" }] },
    progressionRules: "Add load/volume when both athletes hit targets two sessions running.",
    deloadGuidance: "Deload every 6th week or if either athlete reports high fatigue.",
    warmupNotes: "5-10 min general warm-up before every session.",
  },
  record_member_layer: {
    currentState: {
      summary: "Progressing well, training load balanced.",
      trainingLoad: { ctl: 40, atl: 36, tsb: 4 },
      highlights: ["Squat e1RM up 3% over 3 weeks"],
    },
    coachNotes: null,
    sportNotes: null,
    nutritionNote: null,
    sessionLoads: [
      { day: "Monday", exercises: [{ name: "Back Squat", load_note: "Work up to a top set of 6 around 80kg." }, { name: "Sled Push", load_note: "Moderate load, focus on drive." }] },
      { day: "Tuesday", exercises: [{ name: "Row Intervals", load_note: "Hold 2:00/500m pace." }] },
      { day: "Wednesday", exercises: [{ name: "HIIT Class", load_note: null }] },
      { day: "Thursday", exercises: [{ name: "Deadlift", load_note: "Top set of 5 around 100kg." }, { name: "Wall Ball", load_note: "9kg ball, unbroken sets." }] },
      { day: "Friday", exercises: [{ name: "Hyrox Class", load_note: null }] },
      { day: "Saturday", exercises: [{ name: "Farmers Carry", load_note: "24kg per hand, 4x40m." }] },
    ],
  },
  record_meal_plan: {
    days: [
      {
        label: "Day 1",
        meals: [
          { name: "Breakfast", items: "Oats with whey protein and berries", kcal: 500, protein_g: 35, carbs_g: 60, fat_g: 10, notes: null },
          { name: "Lunch", items: "Chicken breast, rice, broccoli", kcal: 700, protein_g: 50, carbs_g: 70, fat_g: 15, notes: null },
          { name: "Dinner", items: "Salmon, sweet potato, salad", kcal: 650, protein_g: 40, carbs_g: 55, fat_g: 20, notes: null },
        ],
        totals: { kcal: 1850, p: 125, c: 185, f: 45 },
      },
    ],
    groceryList: ["Oats", "Whey protein", "Chicken breast", "Rice", "Salmon", "Sweet potato"],
    notes: "Adjust portions to hit your exact calorie target.",
  },
  record_body_scan: {
    weight_kg: 78.5,
    body_fat_pct: 18.2,
    muscle_mass_kg: 34.1,
    skeletal_muscle_mass_kg: 32.0,
    bmr_kcal: 1750,
    visceral_fat_level: 6,
    bmi: 23.4,
    whr: 0.88,
    posture_findings: null,
    scan_date: "2026-08-20",
    source: "visbody",
  },
};

const VALIDATORS: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }> = {
  record_program_overview: programOverviewSchema,
  record_program_schedule: programScheduleSchema,
  record_program_update: programUpdateSchema,
  record_group_program: programSharedSchema,
  record_member_layer: memberLayerSchema,
  record_meal_plan: mealPlanSchema,
  record_body_scan: bodyScanExtractionSchema,
};

/** Every fixture must validate against the real schema it stands in for — run in a sanity test, not at import time, so a failure reports clearly. */
export function validateFixtures(): void {
  for (const [toolName, validator] of Object.entries(VALIDATORS)) {
    const result = validator.safeParse(FIXTURES[toolName]);
    if (!result.success) {
      throw new Error(`Fixture for "${toolName}" doesn't match its schema: ${JSON.stringify(result.error)}`);
    }
  }
}

/**
 * The default extractStructuredJson replacement: looks up FIXTURES by
 * params.toolName and returns a fresh deep clone (so a test that mutates its
 * result, e.g. to write it to Firestore, can't leak into the next test).
 * Wire it up per-test-file with `vi.hoisted`:
 *
 *   const mockExtractStructuredJson = vi.hoisted(() => vi.fn());
 *   vi.mock("../src/lib/claude", () => ({ extractStructuredJson: mockExtractStructuredJson, MODEL: "claude-sonnet-4-5-20250929" }));
 *   beforeEach(() => mockExtractStructuredJson.mockImplementation(defaultFixtureResponse));
 *
 * A single test that needs a different response for one call uses
 * `mockExtractStructuredJson.mockImplementationOnce(async () => ({...}))`.
 */
export async function defaultFixtureResponse(params: { toolName: string }): Promise<unknown> {
  const base = FIXTURES[params.toolName];
  if (base === undefined) throw new Error(`No fixture registered for toolName "${params.toolName}"`);
  return structuredClone(base);
}
