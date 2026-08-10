import { z } from "zod";

export const bodyScanExtractionSchema = z.object({
  weight_kg: z.number().min(20).max(300).nullable(),
  body_fat_pct: z.number().min(3).max(60).nullable(),
  muscle_mass_kg: z.number().min(10).max(150).nullable(),
  skeletal_muscle_mass_kg: z.number().min(5).max(100).nullable(),
  bmr_kcal: z.number().min(500).max(5000).nullable(),
  visceral_fat_level: z.number().min(0).max(30).nullable(),
  bmi: z.number().min(10).max(60).nullable(),
  whr: z.number().min(0.5).max(1.5).nullable(),
  posture_findings: z.string().nullable(),
  scan_date: z.string().nullable(), // YYYY-MM-DD if visible on the report
  source: z.enum(["visbody", "evolt", "other"]),
});
export type BodyScanExtraction = z.infer<typeof bodyScanExtractionSchema>;

export const bodyScanExtractionJsonSchema = {
  type: "object",
  properties: {
    weight_kg: { type: ["number", "null"] },
    body_fat_pct: { type: ["number", "null"] },
    muscle_mass_kg: { type: ["number", "null"] },
    skeletal_muscle_mass_kg: { type: ["number", "null"] },
    bmr_kcal: { type: ["number", "null"] },
    visceral_fat_level: { type: ["number", "null"] },
    bmi: { type: ["number", "null"] },
    whr: { type: ["number", "null"] },
    posture_findings: { type: ["string", "null"], description: "Brief summary of any posture findings (e.g. forward head, pelvic tilt), or null if not a posture report." },
    scan_date: { type: ["string", "null"], description: "The scan/test date shown on the report, as YYYY-MM-DD, or null if not visible." },
    source: { type: "string", enum: ["visbody", "evolt", "other"] },
  },
  required: ["weight_kg", "body_fat_pct", "muscle_mass_kg", "skeletal_muscle_mass_kg", "bmr_kcal", "visceral_fat_level", "bmi", "whr", "posture_findings", "scan_date", "source"],
};

const exerciseSchema = z.object({
  name: z.string(),
  sets: z.number().int().min(1).max(12),
  reps: z.string(), // e.g. "6-8", "12-15", "5 km", "30 min"
  rir: z.string(),  // e.g. "2", "1-2", "n/a" for conditioning
  rest_seconds: z.number().int().min(0).max(600),
  load_note: z.string().nullable(),
  substitution_note: z.string().nullable(),
});

export const programSchema = z.object({
  title: z.string(),                 // e.g. "Hybrid Base Block → Hyrox"
  goalSummary: z.string(),           // one-line framing tied to the athlete's goal
  split: z.string(),
  daysPerWeek: z.number().int().min(1).max(7),

  // Data-grounded "where you are now" — populated from intervals.icu wellness,
  // recent activities, and lift history when available; null when there's no data.
  currentState: z.object({
    summary: z.string(),
    trainingLoad: z.object({ ctl: z.number(), atl: z.number(), tsb: z.number() }).nullable(),
    highlights: z.array(z.string()), // progress / stalls / misses called out from the data
  }).nullable(),

  // Target events driving periodization (empty for open-ended goals).
  events: z.array(z.object({
    name: z.string(),
    date: z.string().nullable(),
    weeksOut: z.string().nullable(),
    goal: z.string(),
  })),

  // Multi-phase periodized roadmap (empty for simple non-event goals).
  roadmap: z.array(z.object({
    phase: z.string(),
    dates: z.string(),
    focus: z.string(),
    lifting: z.string(),
    running: z.string().nullable(),
    nutrition: z.string().nullable(),
  })),

  // Day-by-day weekly overview with placement rationale (empty allowed).
  weeklyStructure: z.array(z.object({
    day: z.string(),
    focus: z.string(),
    note: z.string().nullable(),
  })),

  sessions: z.array(z.object({
    day: z.string(),
    label: z.string(),
    focus_note: z.string().nullable(),
    exercises: z.array(exerciseSchema).min(1).max(14),
  })).min(1).max(10),

  // Running / endurance programming for hybrid & endurance goals; null otherwise.
  running: z.object({
    pacesNote: z.string(),
    sessions: z.array(z.object({ name: z.string(), detail: z.string() })),
  }).nullable(),

  progressionRules: z.string(),
  deloadGuidance: z.string(),
  warmupNotes: z.string(),
  coachNotes: z.string().nullable(),     // injury / mobility / recovery guidance
  sportNotes: z.string().nullable(),     // event-specific strategy (e.g. Hyrox station splits)
  nutritionNote: z.string().nullable(),  // program-side fueling guidance
});
export type ProgramOutput = z.infer<typeof programSchema>;

const exerciseJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    sets: { type: "integer" },
    reps: { type: "string", description: "Rep target, or distance/time for conditioning (e.g. '6-8', '5 km', '30 min')." },
    rir: { type: "string", description: "Reps in reserve for lifts (e.g. '2', '1-2'); 'n/a' for conditioning." },
    rest_seconds: { type: "integer" },
    load_note: { type: ["string", "null"] },
    substitution_note: { type: ["string", "null"] },
  },
  required: ["name", "sets", "reps", "rir", "rest_seconds", "load_note", "substitution_note"],
};

export const programJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short program title tied to the goal, e.g. 'Hybrid Base Block → Hyrox'." },
    goalSummary: { type: "string", description: "One sentence framing how this program serves the athlete's stated goal." },
    split: { type: "string" },
    daysPerWeek: { type: "integer", minimum: 1, maximum: 7 },
    currentState: {
      type: ["object", "null"],
      description: "Data-grounded snapshot of where the athlete is now, from their training-load, recent activities, and lift history. Null only if there is genuinely no data to ground it in.",
      properties: {
        summary: { type: "string" },
        trainingLoad: {
          type: ["object", "null"],
          properties: { ctl: { type: "number" }, atl: { type: "number" }, tsb: { type: "number" } },
          required: ["ctl", "atl", "tsb"],
        },
        highlights: { type: "array", items: { type: "string" }, description: "Specific progress, stalls, or misses read from the data." },
      },
      required: ["summary", "trainingLoad", "highlights"],
    },
    events: {
      type: "array",
      description: "Target events driving periodization; empty array for open-ended goals.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          date: { type: ["string", "null"] },
          weeksOut: { type: ["string", "null"] },
          goal: { type: "string" },
        },
        required: ["name", "date", "weeksOut", "goal"],
      },
    },
    roadmap: {
      type: "array",
      description: "Periodized phases building toward the events; empty array if a single-phase plan is appropriate.",
      items: {
        type: "object",
        properties: {
          phase: { type: "string" },
          dates: { type: "string" },
          focus: { type: "string" },
          lifting: { type: "string" },
          running: { type: ["string", "null"] },
          nutrition: { type: ["string", "null"] },
        },
        required: ["phase", "dates", "focus", "lifting", "running", "nutrition"],
      },
    },
    weeklyStructure: {
      type: "array",
      description: "Day-by-day overview of the current phase's week, with placement rationale.",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          focus: { type: "string" },
          note: { type: ["string", "null"] },
        },
        required: ["day", "focus", "note"],
      },
    },
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          label: { type: "string" },
          focus_note: { type: ["string", "null"] },
          exercises: { type: "array", items: exerciseJsonSchema },
        },
        required: ["day", "label", "focus_note", "exercises"],
      },
    },
    running: {
      type: ["object", "null"],
      description: "Running/endurance programming for hybrid & endurance goals; null for pure strength/physique goals.",
      properties: {
        pacesNote: { type: "string" },
        sessions: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, detail: { type: "string" } },
            required: ["name", "detail"],
          },
        },
      },
      required: ["pacesNote", "sessions"],
    },
    progressionRules: { type: "string" },
    deloadGuidance: { type: "string" },
    warmupNotes: { type: "string" },
    coachNotes: { type: ["string", "null"] },
    sportNotes: { type: ["string", "null"] },
    nutritionNote: { type: ["string", "null"] },
  },
  required: [
    "title", "goalSummary", "split", "daysPerWeek", "currentState", "events", "roadmap",
    "weeklyStructure", "sessions", "running", "progressionRules", "deloadGuidance",
    "warmupNotes", "coachNotes", "sportNotes", "nutritionNote",
  ],
};

const mealSchema = z.object({
  name: z.string(),
  items: z.string(),
  kcal: z.number().min(0),
  protein_g: z.number().min(0),
  carbs_g: z.number().min(0),
  fat_g: z.number().min(0),
  notes: z.string().nullable(),
});

export const mealPlanSchema = z.object({
  days: z.array(z.object({
    label: z.string(),
    meals: z.array(mealSchema).min(1).max(8),
    totals: z.object({ kcal: z.number(), p: z.number(), c: z.number(), f: z.number() }),
  })).min(1).max(7),
  groceryList: z.array(z.string()),
  notes: z.string(),
});
export type MealPlanOutput = z.infer<typeof mealPlanSchema>;

export const mealPlanJsonSchema = {
  type: "object",
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          meals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                items: { type: "string" },
                kcal: { type: "number" },
                protein_g: { type: "number" },
                carbs_g: { type: "number" },
                fat_g: { type: "number" },
                notes: { type: ["string", "null"] },
              },
              required: ["name", "items", "kcal", "protein_g", "carbs_g", "fat_g", "notes"],
            },
          },
          totals: {
            type: "object",
            properties: { kcal: { type: "number" }, p: { type: "number" }, c: { type: "number" }, f: { type: "number" } },
            required: ["kcal", "p", "c", "f"],
          },
        },
        required: ["label", "meals", "totals"],
      },
    },
    groceryList: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["days", "groceryList", "notes"],
};
