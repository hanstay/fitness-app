// One-off manual verification (not part of the automated suite): uses the
// Admin SDK (bypasses Security Rules, same trust level as a Cloud Function)
// to seed a realistic program + meal plan + targets for a test user, so the
// dashboard/program/meals/profile pages can be visually verified WITHOUT
// needing a live Anthropic API call. This tests the rendering pages (task 11)
// independently of the generation functions (task 10), which are already
// unit-tested/code-reviewed but can't be live-called until the API key is set up.
import admin from "firebase-admin";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

admin.initializeApp({ projectId: "hj-training-program-hj2t3of5" });
const db = admin.firestore();
const auth = admin.auth();

const email = "rendertest@example.com";
let uid;
try {
  const user = await auth.getUserByEmail(email);
  uid = user.uid;
} catch {
  const user = await auth.createUser({ email, password: "testpassword123" });
  uid = user.uid;
}
console.log("Test user:", uid);

// admin.createUser() ALSO fires the real onUserCreate trigger (asynchronously),
// which does a plain (non-merge) .set() on users/{uid} — if our seed write below
// races ahead of it, the trigger clobbers our data when it lands moments later.
// Wait for the trigger's shell to appear first, so our merge write lands after it.
for (let i = 0; i < 20; i++) {
  const snap = await db.doc(`users/${uid}`).get();
  if (snap.exists) break;
  await new Promise((r) => setTimeout(r, 250));
}

await db.doc(`users/${uid}`).set({
  uid, email, displayName: "Render Test",
  onboarding: { completed: true, step: "done", updatedAt: admin.firestore.FieldValue.serverTimestamp() },
  athlete: {
    sex: "male", age: 30, height_cm: 174, bodyweight_kg: 70.5, body_fat_pct: 12.7,
    activity_level: "very_active", equipment: ["barbell", "dumbbells", "cables"],
    training_days_per_week: 5, session_length_minutes: 75, preferred_split: "Push/Pull/Legs",
    training_experience_years: 3, injuries_constraints: "None reported.",
    events: [{ name: "Hyrox Singapore", date: "2026-11-29" }],
    goal: "Hybrid: hypertrophy + Hyrox performance",
    current_lifts: [{ exercise: "Squat (Barbell)", weight_kg: 90, reps: 6, date: "2026-07-21" }],
    recovery: { sleep_hours: 6.5, sleep_quality: "fair", stress_1_10: 5 },
  },
  nutrition: {
    diet_style: "omnivore", allergies: [], foods_to_avoid: [], preferred_cuisines: ["Chinese", "Japanese"],
    meals_per_day: 3, cooking_time_preference: "mix", eat_out_frequency: "often",
    budget_preference: null, supplements: ["whey", "creatine"],
  },
}, { merge: true });

const programRef = db.collection(`users/${uid}/programs`).doc();
await programRef.set({
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
  status: "active",
  model: "claude-sonnet-4-5-20250929",
  split: "Push/Pull/Legs",
  daysPerWeek: 5,
  sessions: [
    {
      day: "Monday", label: "Push",
      exercises: [
        { name: "Bench Press (Barbell)", sets: 4, reps: "6-8", rir: "2", rest_seconds: 150, load_note: "Start ~70kg", substitution_note: null },
        { name: "Lateral Raise (Cable)", sets: 3, reps: "12-15", rir: "1", rest_seconds: 60, load_note: null, substitution_note: "Machine lateral raise if cables busy" },
      ],
    },
    {
      day: "Wednesday", label: "Pull",
      exercises: [
        { name: "Deadlift (Barbell)", sets: 3, reps: "5-6", rir: "2-3", rest_seconds: 180, load_note: "Start ~90kg", substitution_note: "Trap bar deadlift if lower back is cranky" },
      ],
    },
  ],
  progressionRules: "Double progression: add reps within range, then add load and reset reps.",
  deloadGuidance: "Deload around week 6 — cut volume ~40%, keep RIR 3-4.",
  warmupNotes: "5-10 min general warm-up + hip flexor mobility before lower-body work.",
  profileSnapshot: {},
});

const mealPlanRef = db.collection(`users/${uid}/mealPlans`).doc();
await mealPlanRef.set({
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
  status: "active",
  model: "claude-sonnet-4-5-20250929",
  targetsSnapshot: { kcal: 3090, p: 141, c: 438, f: 86 },
  days: [
    {
      label: "Template Day",
      meals: [
        { name: "Lunch", items: "Grilled chicken rice bowl, extra chicken", kcal: 1100, protein_g: 65, carbs_g: 140, fat_g: 25, notes: null },
        { name: "Dinner", items: "Chicken rice, boiled egg add-on", kcal: 1160, protein_g: 68, carbs_g: 170, fat_g: 28, notes: "Ask for skin removed" },
      ],
      totals: { kcal: 2260, p: 133, c: 310, f: 53 },
    },
  ],
  groceryList: ["Whey protein", "Bananas", "Greek yogurt"],
  notes: "Hits protein comfortably; add a snack to close the calorie gap on training days.",
});

await db.doc(`users/${uid}/state/summary`).set({
  currentTargets: { bmr: 1647.5, activity_factor: 1.725, tdee: 2842, target_calories: 3090, protein_g: 141, carbs_g: 438, fat_g: 86, calculated_at: admin.firestore.FieldValue.serverTimestamp() },
  currentProgramId: programRef.id,
  currentMealPlanId: mealPlanRef.id,
  wellness: { ctl: 7.6, atl: 10.3, tsb: -2.7, asOf: "2026-08-02" },
  integrationsStatus: {
    intervalsIcu: { connected: true, athleteId: "i661579", verifiedAt: admin.firestore.FieldValue.serverTimestamp(), lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(), activitiesSynced: 23, lastError: null },
    hevy: { csvUploaded: true, storagePath: null, parsedAt: admin.firestore.FieldValue.serverTimestamp(), liftsImported: 40, lastError: null },
  },
}, { merge: true });

await db.doc(`users/${uid}/bodyScans/scan1`).set({
  date: "2026-07-22", source: "visbody", storagePath: null,
  extracted: { weight_kg: 70.5, body_fat_pct: 12.7, muscle_mass_kg: 58.5, skeletal_muscle_mass_kg: 35.2, bmr_kcal: 1703.8, visceral_fat_level: 2, bmi: 23.3, whr: 0.83, posture_findings: "Mild right rounded shoulder, improving." },
  extractedAt: admin.firestore.FieldValue.serverTimestamp(),
  confirmedByUser: true,
  rawModelOutput: null,
});

console.log("Seeded profile, program, meal plan, targets, wellness, and a body scan for", email);
console.log("Sign in as this user in the browser to visually verify dashboard/program/meals/profile.");
process.exit(0);
