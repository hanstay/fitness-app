// Emulator-backed: runGenerateMealPlan's preconditions, the archive-and-write
// batch, and the excluded-food safety guard, with only the LLM boundary
// mocked. See functions/test/README.md for how to run this.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { getTestDb, clearFirestoreEmulator } from "./helpers/emulatorFirestore";
import { FIXTURES, defaultFixtureResponse } from "./fixtures/llmFixtures";
import { runGenerateMealPlan } from "../src/generate/generateMealPlan";

const mockExtractStructuredJson = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/claude", () => ({
  extractStructuredJson: mockExtractStructuredJson,
  MODEL: "claude-sonnet-4-5-20250929",
}));

const db = getTestDb();

async function seedUser(uid: string, nutritionOverrides: Record<string, unknown> = {}, currentTargets: Record<string, unknown> | null = { target_calories: 2200, protein_g: 160, carbs_g: 220, fat_g: 70 }) {
  await db.doc(`users/${uid}`).set({
    uid,
    nutrition: { meals_per_day: 3, allergies: [], foods_to_avoid: [], preferred_cuisines: [], diet_style: "omnivore", ...nutritionOverrides },
  });
  await db.doc(`users/${uid}/state/summary`).set({ currentTargets, currentMealPlanId: null });
}

beforeEach(async () => {
  await clearFirestoreEmulator();
  mockExtractStructuredJson.mockReset();
  mockExtractStructuredJson.mockImplementation(defaultFixtureResponse);
});

describe("meal plan generation", () => {
  it("scenario 1: happy path archives the prior active plan and writes the new one", async () => {
    await seedUser("m1");
    await db.collection("users/m1/mealPlans").add({ status: "active", createdAt: new Date() });

    const result = await runGenerateMealPlan("m1");

    const activeSnap = await db.collection("users/m1/mealPlans").where("status", "==", "active").get();
    expect(activeSnap.size).toBe(1);
    expect(activeSnap.docs[0].id).toBe(result.mealPlanId);
    expect(activeSnap.docs[0].data().targetsSnapshot).toEqual({ kcal: 2200, p: 160, c: 220, f: 70 });

    const archivedSnap = await db.collection("users/m1/mealPlans").where("status", "==", "archived").get();
    expect(archivedSnap.size).toBe(1);

    const summary = await db.doc("users/m1/state/summary").get();
    expect(summary.data()?.currentMealPlanId).toBe(result.mealPlanId);
  });

  it("scenario 2: missing currentTargets fails before any LLM call", async () => {
    await seedUser("m2", {}, null);

    await expect(runGenerateMealPlan("m2")).rejects.toThrow(/targets/i);
    expect(mockExtractStructuredJson).not.toHaveBeenCalled();
  });

  it("scenario 3: a plan containing an excluded food is rejected", async () => {
    await seedUser("m3", { allergies: ["peanuts"] });
    mockExtractStructuredJson.mockImplementationOnce(async () => ({
      ...(FIXTURES.record_meal_plan as Record<string, unknown>),
      days: [{
        label: "Day 1",
        meals: [{ name: "Snack", items: "Toast with peanuts", kcal: 300, protein_g: 10, carbs_g: 30, fat_g: 15, notes: null }],
        totals: { kcal: 300, p: 10, c: 30, f: 15 },
      }],
    }));

    await expect(runGenerateMealPlan("m3")).rejects.toThrow(/peanuts/i);
  });
});
