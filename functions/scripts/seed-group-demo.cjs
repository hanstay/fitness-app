// Dev-only: seeds the emulator suite with two demo users already in a
// shared training group, so groups.html/program.html can be clicked through
// without a real ANTHROPIC_API_KEY. Never run against production — it only
// works against the emulator anyway (points FIRESTORE/AUTH_EMULATOR_HOST env
// vars before initializing firebase-admin).
//
// Usage (with the emulator suite already running):
//   cd functions && node scripts/seed-group-demo.cjs

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp({ projectId: "fitness-app-47a06" });
const db = getFirestore();
const auth = getAuth();

const ALICE = { email: "alice@example.com", password: "password123", displayName: "Alice" };
const BOB = { email: "bob@example.com", password: "password123", displayName: "Bob" };

async function getOrCreateUser(spec) {
  try {
    return await auth.getUserByEmail(spec.email);
  } catch {
    return auth.createUser(spec);
  }
}

function baseAthlete(overrides) {
  return {
    sex: null, age: 30, height_cm: 175, bodyweight_kg: 75, bodyweight_date: null,
    body_fat_pct: null, activity_level: "moderate",
    equipment: ["barbell", "dumbbells", "rack"],
    training_days_per_week: 4, session_length_minutes: 60, preferred_split: "Upper/Lower",
    training_experience_years: 3, injuries_constraints: "", events: [], fixed_sessions: [],
    goal: "Get stronger together", current_lifts: [],
    recovery: { sleep_hours: 7, sleep_quality: "good", stress_1_10: 4 },
    ...overrides,
  };
}

async function seedUser(uid, spec, athleteOverrides) {
  const now = FieldValue.serverTimestamp();
  await db.doc(`users/${uid}`).set({
    uid, email: spec.email, displayName: spec.displayName, createdAt: now,
    onboarding: { completed: true, step: "done", updatedAt: now },
    athlete: baseAthlete(athleteOverrides),
    nutrition: {
      diet_style: "omnivore", allergies: [], foods_to_avoid: [], preferred_cuisines: [],
      meals_per_day: 3, cooking_time_preference: "mix", eat_out_frequency: "sometimes",
      budget_preference: null, supplements: [],
    },
  });
  await db.doc(`credentials/${uid}`).set({ intervalsIcu: null, updatedAt: now });
}

const SHARED_SESSIONS = [
  {
    day: "Monday", label: "Upper — Push", focus_note: "Heavy press day",
    exercises: [
      { name: "Barbell Bench Press", sets: 4, reps: "5-6", rir: "2", rest_seconds: 150, load_note: null, substitution_note: "If no barbell, use DB bench press" },
      { name: "Overhead Press", sets: 3, reps: "6-8", rir: "2", rest_seconds: 120, load_note: null, substitution_note: null },
    ],
  },
  {
    day: "Tuesday", label: "Lower — Squat", focus_note: null,
    exercises: [
      { name: "Back Squat", sets: 4, reps: "5-6", rir: "2", rest_seconds: 180, load_note: null, substitution_note: "If knee sensitive, use leg press" },
      { name: "Romanian Deadlift", sets: 3, reps: "8-10", rir: "2", rest_seconds: 120, load_note: null, substitution_note: null },
    ],
  },
  { day: "Wednesday", label: "Rest", focus_note: null, exercises: [{ name: "Rest", sets: 1, reps: "n/a", rir: "n/a", rest_seconds: 0, load_note: null, substitution_note: null }] },
  {
    day: "Thursday", label: "Upper — Pull", focus_note: null,
    exercises: [
      { name: "Weighted Pull-up", sets: 4, reps: "5-8", rir: "2", rest_seconds: 150, load_note: null, substitution_note: "If no pull-up bar, use lat pulldown" },
      { name: "Barbell Row", sets: 3, reps: "8-10", rir: "2", rest_seconds: 120, load_note: null, substitution_note: null },
    ],
  },
];

const SHARED_PROGRAM = {
  title: "Strength Base — Training Together",
  goalSummary: "Build a shared strength base while accommodating each person's own constraints.",
  split: "Upper/Lower",
  daysPerWeek: 4,
  events: [],
  roadmap: [
    { phase: "Base", dates: "Weeks 1-6", focus: "Build baseline strength", lifting: "Upper/Lower, moderate volume", running: null, nutrition: null },
  ],
  weeklyStructure: SHARED_SESSIONS.map((s) => ({ day: s.day, focus: s.label, note: s.focus_note })),
  sessions: SHARED_SESSIONS,
  running: null,
  progressionRules: "Add load when both reps and RIR targets are hit for two sessions in a row.",
  deloadGuidance: "Deload volume ~40% every 6th week or if either of you reports high fatigue.",
  warmupNotes: "5-10 min general warm-up, then 2-3 ramping sets on the first lift of the day.",
};

async function main() {
  const aliceUser = await getOrCreateUser(ALICE);
  const bobUser = await getOrCreateUser(BOB);
  const aliceUid = aliceUser.uid, bobUid = bobUser.uid;

  // onUserCreate (the Auth-triggered Cloud Function) writes its own default
  // users/{uid} doc asynchronously right after createUser() resolves, and it
  // does a full overwrite (not a merge) — racing our own profile write below.
  // Give it a moment to land first so ours (written after) wins.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  await seedUser(aliceUid, ALICE, { goal: "Get stronger, no major constraints" });
  await seedUser(bobUid, BOB, { goal: "Get stronger, avoid loading a cranky left shoulder", injuries_constraints: "Left shoulder impingement — avoid heavy overhead pressing" });

  const groupRef = db.collection("groups").doc("demo-group");
  await groupRef.set({
    memberUids: [aliceUid, bobUid],
    memberEmails: { [aliceUid]: ALICE.email, [bobUid]: BOB.email },
    createdAt: FieldValue.serverTimestamp(),
  });

  const programRef = groupRef.collection("programs").doc();
  await programRef.set({
    createdAt: FieldValue.serverTimestamp(),
    status: "active",
    model: "stub-demo-data",
    ...SHARED_PROGRAM,
    profileSnapshots: {
      [aliceUid]: baseAthlete({ goal: "Get stronger, no major constraints" }),
      [bobUid]: baseAthlete({ goal: "Get stronger, avoid loading a cranky left shoulder", injuries_constraints: "Left shoulder impingement" }),
    },
  });

  await groupRef.collection("members").doc(aliceUid).set({
    currentState: {
      summary: "Alice is progressing well on all lifts, training load is balanced.",
      trainingLoad: { ctl: 42, atl: 38, tsb: 4 },
      highlights: ["Bench press e1RM up 5% over 3 weeks", "Consistent 4x/week attendance"],
    },
    coachNotes: null,
    sportNotes: null,
    nutritionNote: "Slight calorie surplus to support the strength phase.",
    sessionLoads: SHARED_SESSIONS.map((s) => ({
      day: s.day,
      exercises: s.exercises.map((ex) => ({
        name: ex.name,
        load_note: ex.name === "Rest" ? null : "Work up to a top set around 80% of recent best, then match on backoffs.",
      })),
    })),
    profileSnapshot: baseAthlete({ goal: "Get stronger, no major constraints" }),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await groupRef.collection("members").doc(bobUid).set({
    currentState: {
      summary: "Bob's lower-body lifts are trending up; upper pressing is being managed around his shoulder.",
      trainingLoad: { ctl: 35, atl: 33, tsb: 2 },
      highlights: ["Squat e1RM up 3% over 3 weeks", "Overhead press capped to pain-free range"],
    },
    coachNotes: "Keep overhead pressing pain-free — favor landmine or neutral-grip DB press over barbell OHP if there's any pinching.",
    sportNotes: null,
    nutritionNote: null,
    sessionLoads: SHARED_SESSIONS.map((s) => ({
      day: s.day,
      exercises: s.exercises.map((ex) => ({
        name: ex.name,
        load_note: ex.name === "Overhead Press"
          ? "Swap to neutral-grip DB press, work up to a comfortable top set of 8, stop short of any shoulder pinch."
          : ex.name === "Rest" ? null
          : "Work up to a top set around 75% of recent best, then match on backoffs.",
      })),
    })),
    profileSnapshot: baseAthlete({ goal: "Get stronger, avoid loading a cranky left shoulder", injuries_constraints: "Left shoulder impingement" }),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.doc(`users/${aliceUid}/state/summary`).set({
    currentTargets: null, currentTargetHistoryId: null, currentProgramId: null, currentMealPlanId: null,
    wellness: null, groupId: groupRef.id, activeProgramSource: "group",
    integrationsStatus: {
      intervalsIcu: { connected: false, athleteId: null, verifiedAt: null, lastSyncedAt: null, activitiesSynced: 0, lastError: null },
      hevy: { csvUploaded: false, storagePath: null, parsedAt: null, liftsImported: 0, lastError: null },
    },
  });
  await db.doc(`users/${bobUid}/state/summary`).set({
    currentTargets: null, currentTargetHistoryId: null, currentProgramId: null, currentMealPlanId: null,
    wellness: null, groupId: groupRef.id, activeProgramSource: "group",
    integrationsStatus: {
      intervalsIcu: { connected: false, athleteId: null, verifiedAt: null, lastSyncedAt: null, activitiesSynced: 0, lastError: null },
      hevy: { csvUploaded: false, storagePath: null, parsedAt: null, liftsImported: 0, lastError: null },
    },
  });

  console.log("Seeded demo group:", groupRef.id);
  console.log(`Sign in at http://127.0.0.1:5000/login.html as:`);
  console.log(`  ${ALICE.email} / ${ALICE.password}`);
  console.log(`  ${BOB.email} / ${BOB.password}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
