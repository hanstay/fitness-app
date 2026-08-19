// Manual latency probe — NOT part of the CI suite (CI has no
// ANTHROPIC_API_KEY, so every case below skips itself automatically). Run it
// yourself against your own key to answer "is the 300s function timeout /
// 6-minute stale threshold actually fair for the calls we make?":
//
//   ANTHROPIC_API_KEY=sk-ant-... npx vitest run test/generationLatency.manual.test.ts
//
// It calls the exact real system prompts + schemas each generation path
// uses, with representative (not real-user) profile data, and prints wall
// time against a fixture request. This is one-off/local signal; for the
// ongoing, real-traffic answer see the durationMs field extractStructuredJson
// now logs on every call (lib/claude.ts) — query Cloud Logging for
// "extractStructuredJson call completed" once you have production volume.
import { describe, it, expect } from "vitest";
import { extractStructuredJson } from "../src/lib/claude";
import {
  OVERVIEW_SYSTEM_PROMPT,
  SCHEDULE_SYSTEM_PROMPT,
  INCREMENTAL_SYSTEM_PROMPT,
} from "../src/generate/generateProgram";
import { MEAL_PLAN_SYSTEM_PROMPT } from "../src/generate/generateMealPlan";
import {
  programOverviewJsonSchema,
  programOverviewSchema,
  programScheduleJsonSchema,
  programScheduleSchema,
  programUpdateJsonSchema,
  programUpdateSchema,
  mealPlanJsonSchema,
  mealPlanSchema,
} from "../src/lib/schemas";

const FUNCTION_TIMEOUT_MS = 300_000;
const STALE_THRESHOLD_MS = 6 * 60 * 1000;

const FIXTURE_PROFILE = `Goal: general hybrid fitness (strength + running), no specific event.
Training days/week: 4. Session length: 60 minutes. Equipment: full commercial gym.
Experience: intermediate (training consistently for 2 years).
Current lifts: Squat 100kg x5, Bench 70kg x5, Deadlift 130kg x5, OHP 45kg x5.
Recent running: 3 runs/week, easy pace ~5:30/km, longest recent run 10km.
Training load (from intervals.icu): CTL 45, ATL 50, TSB -5.
Injuries/limitations: mild left knee soreness after heavy squats, otherwise healthy.
Diet style: omnivore. Meals/day: 3. Allergies: none. Foods to avoid: shellfish.
Preferred cuisines: Italian, Japanese, Singaporean hawker. Cooking time preference: moderate.
Eat-out frequency: 3x/week. Budget preference: moderate.
Target calories: 2600 kcal. Target protein: 180g. Target carbs: 280g. Target fat: 80g.`;

const FIXTURE_EXISTING_WEEK = JSON.stringify({
  weeklyStructure: [
    { day: "Mon", focus: "Lower body strength" },
    { day: "Wed", focus: "Upper body strength" },
    { day: "Fri", focus: "Full body + conditioning" },
    { day: "Sat", focus: "Long run" },
  ],
  sessions: [],
});

interface Case {
  name: string;
  maxTokens: number;
  run: () => Promise<unknown>;
}

const cases: Case[] = [
  {
    name: "program overview (full regen)",
    maxTokens: 3000,
    run: () =>
      extractStructuredJson({
        system: OVERVIEW_SYSTEM_PROMPT,
        userText: `Athlete profile:\n${FIXTURE_PROFILE}\n\nGenerate the goal/periodization half of their program.`,
        toolName: "record_program_overview",
        toolDescription: "Record the goal/periodization half of the generated training program.",
        inputSchema: programOverviewJsonSchema,
        validator: programOverviewSchema,
        maxTokens: 3000,
      }),
  },
  {
    name: "program schedule (full regen)",
    maxTokens: 7000,
    run: () =>
      extractStructuredJson({
        system: SCHEDULE_SYSTEM_PROMPT,
        userText: `Athlete profile:\n${FIXTURE_PROFILE}\n\nGenerate the concrete current-week half of their program.`,
        toolName: "record_program_schedule",
        toolDescription: "Record the concrete current-week half of the generated training program.",
        inputSchema: programScheduleJsonSchema,
        validator: programScheduleSchema,
        maxTokens: 7000,
      }),
  },
  {
    name: "program incremental update",
    maxTokens: 3000,
    run: () =>
      extractStructuredJson({
        system: INCREMENTAL_SYSTEM_PROMPT,
        userText: [
          `Athlete profile:\n${FIXTURE_PROFILE}`,
          ``,
          `Existing current week (adjust this, don't replace the surrounding plan):`,
          FIXTURE_EXISTING_WEEK,
          ``,
          `Generate the adjusted current week + changelog.`,
        ].join("\n"),
        toolName: "record_program_update",
        toolDescription: "Record the adjusted current week of the athlete's program.",
        inputSchema: programUpdateJsonSchema,
        validator: programUpdateSchema,
        maxTokens: 3000,
      }),
  },
  {
    name: "meal plan",
    maxTokens: 8192,
    run: () =>
      extractStructuredJson({
        system: MEAL_PLAN_SYSTEM_PROMPT,
        userText: `Athlete nutrition profile:\n${FIXTURE_PROFILE}\n\nGenerate their meal plan.`,
        toolName: "record_meal_plan",
        toolDescription: "Record the generated meal plan.",
        inputSchema: mealPlanJsonSchema,
        validator: mealPlanSchema,
        maxTokens: 8192,
      }),
  },
];

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("generation latency (manual, real API calls)", () => {
  for (const c of cases) {
    it(
      c.name,
      async () => {
        const startedAt = Date.now();
        await c.run();
        const durationMs = Date.now() - startedAt;

        // eslint-disable-next-line no-console
        console.log(
          `[latency] ${c.name}: ${(durationMs / 1000).toFixed(1)}s` +
            ` (${((durationMs / FUNCTION_TIMEOUT_MS) * 100).toFixed(0)}% of 300s timeout,` +
            ` ${((durationMs / STALE_THRESHOLD_MS) * 100).toFixed(0)}% of 6min stale threshold)`
        );

        // The real question this file exists to answer: does this call fit
        // comfortably inside the budget we've built the retry/stale-detection
        // logic around? Fails loudly if not, rather than just logging.
        expect(durationMs).toBeLessThan(FUNCTION_TIMEOUT_MS);
      },
      // Individual case timeout well above the function budget so a genuinely
      // slow call fails via the assertion above (with a clear message)
      // instead of vitest's own generic timeout error.
      FUNCTION_TIMEOUT_MS + 30_000
    );
  }
});
