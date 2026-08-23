import { describe, it, expect } from "vitest";
import { calculateBmr, calculateMacroTargets } from "../src/lib/macros";

describe("calculateMacroTargets", () => {
  // Real fixture: an actual athlete profile from this session (male, 70.5kg,
  // 174cm, age 30, very_active) — these exact numbers (BMR 1647.5, TDEE 2842,
  // target 3090 kcal, 141g protein, 86g fat, 438g carbs) were hand-derived
  // earlier in the same session and used in a real onboarding conversation,
  // so this is a genuine regression fixture, not a synthetic guess.
  it("matches the hand-derived real profile (male, very_active)", () => {
    const result = calculateMacroTargets({
      sex: "male",
      age: 30,
      height_cm: 174,
      bodyweight_kg: 70.5,
      activity_level: "very_active",
    });
    expect(result.bmr).toBe(1647.5);
    expect(result.tdee).toBe(2842);
    expect(result.target_calories).toBe(3090);
    expect(result.protein_g).toBe(141);
    expect(result.fat_g).toBe(86);
    expect(result.carbs_g).toBe(438);
  });

  // Hand-verified synthetic fixture covering the female BMR branch (not
  // sourced from a real profile in this session — worked out by hand to
  // confirm the -161 offset and sedentary activity factor).
  it("applies the female BMR formula and sedentary factor correctly", () => {
    const result = calculateMacroTargets({
      sex: "female",
      age: 25,
      height_cm: 165,
      bodyweight_kg: 60,
      activity_level: "sedentary",
    });
    expect(result.bmr).toBe(1345.3); // raw formula = 1345.25, rounded to 1 decimal
    expect(result.tdee).toBe(1614);
    expect(result.target_calories).toBe(1860);
    expect(result.protein_g).toBe(120);
    expect(result.fat_g).toBe(52);
    expect(result.carbs_g).toBe(228);
  });

  it("macro grams sum back to (approximately) target calories", () => {
    const result = calculateMacroTargets({
      sex: "male",
      age: 40,
      height_cm: 180,
      bodyweight_kg: 85,
      activity_level: "moderate",
    });
    const total = result.protein_g * 4 + result.carbs_g * 4 + result.fat_g * 9;
    // Rounding each macro independently can drift a few kcal from the target;
    // it should never drift by more than a handful of kcal.
    expect(Math.abs(total - result.target_calories)).toBeLessThanOrEqual(10);
  });

  it("BMR formula matches Mifflin-St Jeor directly (within 1-decimal rounding)", () => {
    // Men: 10*kg + 6.25*cm - 5*age + 5
    const male = calculateBmr({ sex: "male", age: 30, height_cm: 174, bodyweight_kg: 70.5, activity_level: "moderate" });
    expect(male).toBeCloseTo(10 * 70.5 + 6.25 * 174 - 5 * 30 + 5, 1);
    // Women: 10*kg + 6.25*cm - 5*age - 161
    const female = calculateBmr({ sex: "female", age: 25, height_cm: 165, bodyweight_kg: 60, activity_level: "moderate" });
    expect(female).toBeCloseTo(10 * 60 + 6.25 * 165 - 5 * 25 - 161, 1);
  });
});
