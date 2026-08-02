import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { calculateMacroTargets, type ActivityLevel, type Sex } from "../lib/macros";

const VALID_ACTIVITY_LEVELS: ActivityLevel[] = ["sedentary", "light", "moderate", "very_active"];
const VALID_SEXES: Sex[] = ["male", "female"];

export const calculateTargets = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  const athlete = userSnap.data()?.athlete;

  if (!athlete) throw new HttpsError("failed-precondition", "Complete your profile first.");

  const { sex, age, height_cm, bodyweight_kg, activity_level } = athlete;
  if (!VALID_SEXES.includes(sex)) throw new HttpsError("failed-precondition", "Sex is required to calculate targets.");
  if (!age || !height_cm || !bodyweight_kg) {
    throw new HttpsError("failed-precondition", "Age, height, and weight are required to calculate targets.");
  }
  const resolvedActivity: ActivityLevel = VALID_ACTIVITY_LEVELS.includes(activity_level) ? activity_level : "moderate";

  const targets = calculateMacroTargets({ sex, age, height_cm, bodyweight_kg, activity_level: resolvedActivity });

  const targetDoc = {
    bmr: targets.bmr,
    activity_factor: targets.activity_factor,
    tdee: targets.tdee,
    target_calories: targets.target_calories,
    protein_g: targets.protein_g,
    carbs_g: targets.carbs_g,
    fat_g: targets.fat_g,
    calculated_at: FieldValue.serverTimestamp(),
    source: "onboarding" as const,
    inputs: { bodyweight_kg, age, height_cm, sex, activity_level: resolvedActivity },
  };

  const historyRef = db.collection(`users/${uid}/targetHistory`).doc();
  await historyRef.set(targetDoc);
  await db.doc(`users/${uid}/state/summary`).update({
    currentTargets: targetDoc,
    currentTargetHistoryId: historyRef.id,
  });

  return targets;
});
