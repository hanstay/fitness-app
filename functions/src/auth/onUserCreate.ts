// Auth onCreate trigger — seeds the three documents every user needs before
// any client read/write can succeed under the Security Rules (users/{uid},
// state/summary, and the credentials shell). Uses the v1 Auth trigger API;
// Functions v2 has no direct equivalent for a plain Auth onCreate event.
import * as functionsV1 from "firebase-functions/v1";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const onUserCreate = functionsV1.auth.user().onCreate(async (user) => {
  const db = getFirestore();
  const uid = user.uid;
  const now = FieldValue.serverTimestamp();

  const batch = db.batch();

  batch.set(db.doc(`users/${uid}`), {
    uid,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    createdAt: now,
    onboarding: { completed: false, step: "scan", updatedAt: now },
    athlete: {
      sex: null,
      age: null,
      height_cm: null,
      bodyweight_kg: null,
      bodyweight_date: null,
      body_fat_pct: null,
      activity_level: null,
      equipment: [],
      training_days_per_week: null,
      session_length_minutes: null,
      preferred_split: null,
      training_experience_years: null,
      injuries_constraints: "",
      events: [],
      goal: "",
      current_lifts: [],
      recovery: { sleep_hours: null, sleep_quality: null, stress_1_10: null },
    },
    nutrition: {
      diet_style: null,
      allergies: [],
      foods_to_avoid: [],
      preferred_cuisines: [],
      meals_per_day: null,
      cooking_time_preference: null,
      eat_out_frequency: null,
      budget_preference: null,
      supplements: [],
    },
  });

  batch.set(db.doc(`users/${uid}/state/summary`), {
    currentTargets: null,
    currentTargetHistoryId: null,
    currentProgramId: null,
    currentMealPlanId: null,
    wellness: null,
    integrationsStatus: {
      intervalsIcu: {
        connected: false,
        athleteId: null,
        verifiedAt: null,
        lastSyncedAt: null,
        activitiesSynced: 0,
        lastError: null,
      },
      hevy: {
        csvUploaded: false,
        storagePath: null,
        parsedAt: null,
        liftsImported: 0,
        lastError: null,
      },
    },
  });

  batch.set(db.doc(`credentials/${uid}`), {
    intervalsIcu: null,
    updatedAt: now,
  });

  await batch.commit();
});
