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

// ---------------------------------------------------------------------------
// Program sub-shapes — shared across the full program schema and the split
// overview/schedule/update schemas used by generateProgram's two generation
// paths (full-parallel and incremental). Factored out so the split schemas
// can't drift from the full one.
// ---------------------------------------------------------------------------

export const exerciseSchema = z.object({
  name: z.string(),
  sets: z.number().int().min(1).max(12),
  reps: z.string(), // e.g. "6-8", "12-15", "5 km", "30 min"
  rir: z.string(),  // e.g. "2", "1-2", "n/a" for conditioning
  rest_seconds: z.number().int().min(0).max(600),
  load_note: z.string().nullable(),
  substitution_note: z.string().nullable(),
});

export const exerciseJsonSchema = {
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

const currentStateSchema = z.object({
  summary: z.string(),
  trainingLoad: z.object({ ctl: z.number(), atl: z.number(), tsb: z.number() }).nullable(),
  highlights: z.array(z.string()),
}).nullable();

const currentStateJsonSchema = {
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
};

const eventSchema = z.object({
  name: z.string(),
  date: z.string().nullable(),
  weeksOut: z.string().nullable(),
  goal: z.string(),
});
export type EventOutput = z.infer<typeof eventSchema>;

const eventJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    date: { type: ["string", "null"] },
    weeksOut: { type: ["string", "null"] },
    goal: { type: "string" },
  },
  required: ["name", "date", "weeksOut", "goal"],
};

const roadmapPhaseSchema = z.object({
  phase: z.string(),
  dates: z.string(),
  focus: z.string(),
  lifting: z.string(),
  running: z.string().nullable(),
  nutrition: z.string().nullable(),
});

const roadmapPhaseJsonSchema = {
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
};

const weeklyDaySchema = z.object({
  day: z.string(),
  focus: z.string(),
  note: z.string().nullable(),
});

const weeklyDayJsonSchema = {
  type: "object",
  properties: {
    day: { type: "string" },
    focus: { type: "string" },
    note: { type: ["string", "null"] },
  },
  required: ["day", "focus", "note"],
};

export const sessionSchema = z.object({
  day: z.string(),
  label: z.string(),
  focus_note: z.string().nullable(),
  exercises: z.array(exerciseSchema).min(1).max(14),
});
export type SessionOutput = z.infer<typeof sessionSchema>;

const sessionJsonSchema = {
  type: "object",
  properties: {
    day: { type: "string" },
    label: { type: "string" },
    focus_note: { type: ["string", "null"] },
    exercises: { type: "array", items: exerciseJsonSchema },
  },
  required: ["day", "label", "focus_note", "exercises"],
};

const runningSchema = z.object({
  pacesNote: z.string(),
  sessions: z.array(z.object({ name: z.string(), detail: z.string() })),
}).nullable();

const runningJsonSchema = {
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
};

// ---------------------------------------------------------------------------
// Full program — used as the canonical shape a written program document must
// satisfy, and as the final merge-validation check for both generation paths.
// ---------------------------------------------------------------------------

export const programSchema = z.object({
  title: z.string(),                 // e.g. "Hybrid Base Block → Hyrox"
  goalSummary: z.string(),           // one-line framing tied to the athlete's goal
  split: z.string(),
  daysPerWeek: z.number().int().min(1).max(7),
  currentState: currentStateSchema,
  events: z.array(eventSchema),
  roadmap: z.array(roadmapPhaseSchema),
  weeklyStructure: z.array(weeklyDaySchema),
  sessions: z.array(sessionSchema).min(1).max(10),
  running: runningSchema,
  progressionRules: z.string(),
  deloadGuidance: z.string(),
  warmupNotes: z.string(),
  coachNotes: z.string().nullable(),     // injury / mobility / recovery guidance
  sportNotes: z.string().nullable(),     // event-specific strategy (e.g. Hyrox station splits)
  nutritionNote: z.string().nullable(),  // program-side fueling guidance
});
export type ProgramOutput = z.infer<typeof programSchema>;

export const programJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short program title tied to the goal, e.g. 'Hybrid Base Block → Hyrox'." },
    goalSummary: { type: "string", description: "One sentence framing how this program serves the athlete's stated goal." },
    split: { type: "string" },
    daysPerWeek: { type: "integer", minimum: 1, maximum: 7 },
    currentState: currentStateJsonSchema,
    events: {
      type: "array",
      description: "Target events driving periodization; empty array for open-ended goals.",
      items: eventJsonSchema,
    },
    roadmap: {
      type: "array",
      description: "Periodized phases building toward the events; empty array if a single-phase plan is appropriate.",
      items: roadmapPhaseJsonSchema,
    },
    weeklyStructure: {
      type: "array",
      description: "Day-by-day overview of the current phase's week, with placement rationale.",
      items: weeklyDayJsonSchema,
    },
    sessions: { type: "array", items: sessionJsonSchema },
    running: runningJsonSchema,
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

// ---------------------------------------------------------------------------
// Overview / schedule split — the two halves of a full generation, run as
// independent concurrent LLM calls. Together their fields exactly cover
// programSchema (see generateProgram.ts's merge + final programSchema check).
// ---------------------------------------------------------------------------

export const programOverviewSchema = z.object({
  title: z.string(),
  goalSummary: z.string(),
  currentState: currentStateSchema,
  events: z.array(eventSchema),
  roadmap: z.array(roadmapPhaseSchema),
  progressionRules: z.string(),
  deloadGuidance: z.string(),
  warmupNotes: z.string(),
  coachNotes: z.string().nullable(),
  sportNotes: z.string().nullable(),
  nutritionNote: z.string().nullable(),
});
export type ProgramOverviewOutput = z.infer<typeof programOverviewSchema>;

export const programOverviewJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short program title tied to the goal, e.g. 'Hybrid Base Block → Hyrox'." },
    goalSummary: { type: "string", description: "One sentence framing how this program serves the athlete's stated goal." },
    currentState: currentStateJsonSchema,
    events: {
      type: "array",
      description: "Target events driving periodization; empty array for open-ended goals.",
      items: eventJsonSchema,
    },
    roadmap: {
      type: "array",
      description: "Periodized phases building toward the events; empty array if a single-phase plan is appropriate.",
      items: roadmapPhaseJsonSchema,
    },
    progressionRules: { type: "string" },
    deloadGuidance: { type: "string" },
    warmupNotes: { type: "string" },
    coachNotes: { type: ["string", "null"] },
    sportNotes: { type: ["string", "null"] },
    nutritionNote: { type: ["string", "null"] },
  },
  required: [
    "title", "goalSummary", "currentState", "events", "roadmap",
    "progressionRules", "deloadGuidance", "warmupNotes", "coachNotes", "sportNotes", "nutritionNote",
  ],
};

export const programScheduleSchema = z.object({
  split: z.string(),
  daysPerWeek: z.number().int().min(1).max(7),
  weeklyStructure: z.array(weeklyDaySchema),
  sessions: z.array(sessionSchema).min(1).max(10),
  running: runningSchema,
});
export type ProgramScheduleOutput = z.infer<typeof programScheduleSchema>;

export const programScheduleJsonSchema = {
  type: "object",
  properties: {
    split: { type: "string" },
    daysPerWeek: { type: "integer", minimum: 1, maximum: 7 },
    weeklyStructure: {
      type: "array",
      description: "Day-by-day overview of the current phase's week, with placement rationale.",
      items: weeklyDayJsonSchema,
    },
    sessions: { type: "array", items: sessionJsonSchema },
    running: runningJsonSchema,
  },
  required: ["split", "daysPerWeek", "weeklyStructure", "sessions", "running"],
};

// ---------------------------------------------------------------------------
// Incremental update — adjusts only the current block; the rest of the
// program (roadmap, events, goal, etc.) is carried forward unchanged from
// the active program document rather than re-generated.
// ---------------------------------------------------------------------------

export const programUpdateSchema = z.object({
  currentState: currentStateSchema,
  weeklyStructure: z.array(weeklyDaySchema),
  sessions: z.array(sessionSchema).max(10),
  changeSummary: z.array(z.string()),
  coachNotes: z.string().nullable(),
  nutritionNote: z.string().nullable(),
  running: runningSchema,
});
export type ProgramUpdateOutput = z.infer<typeof programUpdateSchema>;

export const programUpdateJsonSchema = {
  type: "object",
  properties: {
    currentState: currentStateJsonSchema,
    weeklyStructure: {
      type: "array",
      description: "Day-by-day overview of the adjusted current week, with placement rationale.",
      items: weeklyDayJsonSchema,
    },
    sessions: {
      type: "array",
      items: sessionJsonSchema,
      description: "Only include an entry for a day whose session you are actually changing. Omit any day whose session should stay exactly as-is in the existing week — it will be carried forward automatically, so do not restate it. May be empty if nothing should change. A day new to the schedule (not present in the existing week) must be included in full, since there is nothing existing to carry forward for it.",
    },
    changeSummary: { type: "array", items: { type: "string" }, description: "Short bullet points of what changed vs the previous block, and why." },
    coachNotes: { type: ["string", "null"] },
    nutritionNote: { type: ["string", "null"] },
    running: runningJsonSchema,
  },
  required: ["currentState", "weeklyStructure", "sessions", "changeSummary", "coachNotes", "nutritionNote", "running"],
};

// ---------------------------------------------------------------------------
// Groups — the shared/individual field split used to shard a program between
// a group's shared structure doc (groups/{groupId}/programs/{id}) and each
// member's personal layer (groups/{groupId}/members/{uid}). Derived from
// programJsonSchema/programSchema rather than hand-duplicated, so the split
// can't drift from the full schema (same principle as the overview/schedule
// split above).
// ---------------------------------------------------------------------------

const PROGRAM_SHARED_FIELD_MASK = {
  title: true, goalSummary: true, split: true, daysPerWeek: true, events: true,
  roadmap: true, weeklyStructure: true, sessions: true, running: true,
  progressionRules: true, deloadGuidance: true, warmupNotes: true,
} as const;
export const PROGRAM_SHARED_FIELDS = Object.keys(PROGRAM_SHARED_FIELD_MASK) as (keyof ProgramOutput)[];
export const programSharedSchema = programSchema.pick(PROGRAM_SHARED_FIELD_MASK);
export type ProgramSharedOutput = z.infer<typeof programSharedSchema>;

export const programSharedJsonSchema = {
  type: "object",
  properties: Object.fromEntries(
    PROGRAM_SHARED_FIELDS.map((k) => [k, (programJsonSchema.properties as Record<string, unknown>)[k]])
  ),
  required: PROGRAM_SHARED_FIELDS,
};

const PROGRAM_INDIVIDUAL_FIELD_MASK = {
  currentState: true, coachNotes: true, sportNotes: true, nutritionNote: true,
} as const;
export const PROGRAM_INDIVIDUAL_FIELDS = Object.keys(PROGRAM_INDIVIDUAL_FIELD_MASK) as (keyof ProgramOutput)[];

// A member's personalized loads for the group's current shared session
// skeleton — one entry per session day, exercises matched to the shared
// sessions[] by day + name (in order). load_note is the only thing that
// varies per member; everything else about the exercise (sets/reps/rir/
// rest/substitution_note) is shared.
export const sessionLoadsSchema = z.array(z.object({
  day: z.string(),
  exercises: z.array(z.object({
    name: z.string(),
    load_note: z.string().nullable(),
  })),
}));
export type SessionLoadsOutput = z.infer<typeof sessionLoadsSchema>;

export const sessionLoadsJsonSchema = {
  type: "array",
  description: "One entry per session day in the given shared schedule, with this athlete's personal load_note for each exercise (matched by day + exercise name, same order as given).",
  items: {
    type: "object",
    properties: {
      day: { type: "string" },
      exercises: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            load_note: { type: ["string", "null"] },
          },
          required: ["name", "load_note"],
        },
      },
    },
    required: ["day", "exercises"],
  },
};

// A group member's generation output: their individual program fields plus
// their personalized loads for the group's current shared schedule.
export const memberLayerSchema = z.object({
  currentState: currentStateSchema,
  coachNotes: z.string().nullable(),
  sportNotes: z.string().nullable(),
  nutritionNote: z.string().nullable(),
  sessionLoads: sessionLoadsSchema,
});
export type MemberLayerOutput = z.infer<typeof memberLayerSchema>;

export const memberLayerJsonSchema = {
  type: "object",
  properties: {
    currentState: currentStateJsonSchema,
    coachNotes: { type: ["string", "null"] },
    sportNotes: { type: ["string", "null"] },
    nutritionNote: { type: ["string", "null"] },
    sessionLoads: sessionLoadsJsonSchema,
  },
  required: ["currentState", "coachNotes", "sportNotes", "nutritionNote", "sessionLoads"],
};

// Input validation for createGroup — deliberately separate from the
// LLM-output `eventSchema` above (which also carries weeksOut/goal, computed
// fields that don't exist on raw user input) and from any per-athlete
// fixed-session shape, since these are what a group *leader* types into the
// create form (public/js/events-editor.js / commitments-editor.js).
export const groupEventInputSchema = z.object({
  name: z.string().min(1).max(120),
  date: z.string().nullable(),
});
export type GroupEventInput = z.infer<typeof groupEventInputSchema>;

export const groupFixedSessionInputSchema = z.object({
  day: z.string().min(1),
  activity: z.string().min(1).max(120),
});
export type GroupFixedSessionInput = z.infer<typeof groupFixedSessionInputSchema>;

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
