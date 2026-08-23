// Deterministic TDEE/macro calculator — ports trainer-intake/SKILL.md's
// "Macro calculation" section verbatim. Pure function, no Firebase
// dependency, so it's independently unit-testable and reusable by Phase 2's
// check-in (which recalculates targets from an updated bodyweight/trend).

export type ActivityLevel = "sedentary" | "light" | "moderate" | "very_active";
export type Sex = "male" | "female";

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
};

// Lean-gain surplus (lower end of the 250-400 kcal range the skill allows) —
// this app is hypertrophy-focused by design, so a conservative surplus is
// the sensible default rather than exposing a bulk/cut choice in v1.
const SURPLUS_KCAL = 250;

// ~2.0 g/kg is the skill's stated default within its 1.6-2.2 g/kg range.
const PROTEIN_G_PER_KG = 2.0;

const FAT_PCT_OF_CALORIES = 0.25;

export interface MacroInputs {
  sex: Sex;
  age: number;
  height_cm: number;
  bodyweight_kg: number;
  activity_level: ActivityLevel;
}

export interface MacroTargets {
  bmr: number;
  activity_factor: number;
  tdee: number;
  target_calories: number;
  surplus_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export function calculateBmr({ sex, age, height_cm, bodyweight_kg }: MacroInputs): number {
  const base = 10 * bodyweight_kg + 6.25 * height_cm - 5 * age;
  const bmr = sex === "male" ? base + 5 : base - 161;
  return Math.round(bmr * 10) / 10;
}

export function calculateMacroTargets(inputs: MacroInputs): MacroTargets {
  const bmr = calculateBmr(inputs);
  const activity_factor = ACTIVITY_FACTORS[inputs.activity_level];
  const tdee = Math.round(bmr * activity_factor);
  const target_calories = Math.round((tdee + SURPLUS_KCAL) / 10) * 10;

  const protein_g = Math.round(inputs.bodyweight_kg * PROTEIN_G_PER_KG);
  const fat_g = Math.round((target_calories * FAT_PCT_OF_CALORIES) / 9);

  const proteinKcal = protein_g * 4;
  const fatKcal = fat_g * 9;
  const carbs_g = Math.round((target_calories - proteinKcal - fatKcal) / 4);

  return {
    bmr,
    activity_factor,
    tdee,
    target_calories,
    surplus_kcal: SURPLUS_KCAL,
    protein_g,
    carbs_g,
    fat_g,
  };
}
