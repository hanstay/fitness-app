import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { ref as storageRef, uploadBytes } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-storage.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { db, storage, functions } from "./firebase-init.js";
import { requireAuth } from "./auth-guard.js";
import { renderEventsEditor, collectEvents } from "./events-editor.js";
import { renderCommitmentsEditor, collectCommitments } from "./commitments-editor.js";
import { connectIntervalsIcuViaOAuth } from "./intervals-oauth.js";

const user = await requireAuth();
if (!user) throw new Error("not authenticated"); // requireAuth already redirected

let uploadedScanId = null;

const errorBox = document.getElementById("errorBox");
const successBox = document.getElementById("successBox");

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = "block";
  successBox.style.display = "none";
}
function showSuccess(msg) {
  successBox.textContent = msg;
  successBox.style.display = "block";
  errorBox.style.display = "none";
}
function clearMessages() {
  errorBox.style.display = "none";
  successBox.style.display = "none";
}

const STEP_KEYS = { 1: "basics", 2: "training", 3: "nutrition" };

function goToStep(n) {
  for (let i = 1; i <= 3; i++) {
    document.getElementById(`step${i}`).style.display = i === n ? "block" : "none";
  }
  document.getElementById("finishing").style.display = "none";
  clearMessages();
  window.scrollTo({ top: 0, behavior: "smooth" });
  updateDoc(doc(db, "users", user.uid), { "onboarding.step": STEP_KEYS[n] }).catch(() => {});
}

/* ---------- field helpers ---------- */

function splitList(id) {
  const v = document.getElementById(id).value.trim();
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
function numOrNull(id) {
  const v = document.getElementById(id).value;
  return v === "" ? null : Number(v);
}
function strOrNull(id) {
  const v = document.getElementById(id).value.trim();
  return v === "" ? null : v;
}

// Repeatable target-events editor (writes athlete.events[]). Starts blank in
// onboarding; state persists in the DOM across Back/Continue within the wizard.
renderEventsEditor(document.getElementById("eventsEditor"), []);
renderCommitmentsEditor(document.getElementById("commitmentsEditor"), []);

/* ---------- Card 1: About you (mandatory) ---------- */

document.getElementById("step1ContinueBtn").addEventListener("click", async () => {
  clearMessages();
  const sex = strOrNull("sex");
  const age = numOrNull("age");
  if (!sex || !age) return showError("Sex and age are required to continue.");

  const btn = document.getElementById("step1ContinueBtn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "users", user.uid), { "athlete.sex": sex, "athlete.age": age });
    goToStep(2);
  } catch (err) {
    showError(`Couldn't save: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Card 2: Training (optional) ---------- */

document.getElementById("step2BackBtn").addEventListener("click", () => goToStep(1));
document.getElementById("step2SkipBtn").addEventListener("click", () => goToStep(3));

document.getElementById("icuConnectBtn").addEventListener("click", async () => {
  clearMessages();
  const status = document.getElementById("icuStatus");
  const btn = document.getElementById("icuConnectBtn");
  status.textContent = "Connecting…";
  btn.disabled = true;
  try {
    const result = await connectIntervalsIcuViaOAuth();
    if (result.cancelled) {
      status.textContent = "";
    } else if (result.syncError) {
      status.textContent = `Connected, but the first sync failed: ${result.syncError}`;
    } else {
      status.textContent = `Connected — synced ${result.activitiesSynced ?? 0} recent activities.`;
    }
  } catch (err) {
    status.textContent = "";
    showError(`Couldn't connect to intervals.icu: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("hevyUploadBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("hevyFile");
  const file = fileInput.files[0];
  const status = document.getElementById("hevyStatus");
  if (!file) return showError("Choose a CSV file first.");
  clearMessages();
  status.textContent = "Uploading and parsing…";
  const btn = document.getElementById("hevyUploadBtn");
  btn.disabled = true;
  try {
    const path = `users/${user.uid}/hevy/latest.csv`;
    await uploadBytes(storageRef(storage, path), file);
    const parseHevy = httpsCallable(functions, "parseHevyCsv");
    const result = await parseHevy({ storagePath: path });
    status.textContent = `Imported ${result.data.liftsImported ?? 0} recent lifts.`;
  } catch (err) {
    status.textContent = "";
    showError(`Couldn't process that CSV: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

// Save training fields with dot-paths so we never clobber nutrition or
// Hevy-imported current_lifts. Returns whether the program can be generated.
async function saveTrainingFields() {
  const days = numOrNull("training_days_per_week");
  const session = numOrNull("session_length_minutes");
  await updateDoc(doc(db, "users", user.uid), {
    "athlete.training_days_per_week": days,
    "athlete.session_length_minutes": session,
    "athlete.training_experience_years": numOrNull("training_experience_years"),
    "athlete.preferred_split": strOrNull("preferred_split"),
    "athlete.equipment": splitList("equipment"),
    "athlete.events": collectEvents(document.getElementById("eventsEditor")),
    "athlete.fixed_sessions": collectCommitments(document.getElementById("commitmentsEditor")),
    "athlete.goal": document.getElementById("goal").value.trim().slice(0, 1000) || null,
    "athlete.injuries_constraints": document.getElementById("injuries_constraints").value.trim().slice(0, 2000) || null,
  });
  return Boolean(days && session);
}

document.getElementById("step2ContinueBtn").addEventListener("click", async () => {
  clearMessages();
  const btn = document.getElementById("step2ContinueBtn");
  btn.disabled = true;
  try {
    const canGenerate = await saveTrainingFields();
    if (canGenerate) {
      // Queues the generation and returns immediately — the actual (multi-
      // minute) LLM call runs in the background so onboarding isn't blocked
      // on it; the dashboard shows "generating" until it lands.
      try {
        await httpsCallable(functions, "queueProgramGeneration")();
      } catch (err) {
        showError(`Couldn't start building your training program: ${err.message || err}`);
        return;
      }
    }
    goToStep(3);
  } catch (err) {
    showError(`Couldn't save your training details: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Card 3: Nutrition (optional) ---------- */

document.getElementById("step3BackBtn").addEventListener("click", () => goToStep(2));

document.getElementById("scanUploadBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("scanFile");
  const file = fileInput.files[0];
  if (!file) return showError("Choose a PDF file first.");
  clearMessages();
  const btn = document.getElementById("scanUploadBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Uploading…';
  try {
    const scanId = crypto.randomUUID();
    const path = `users/${user.uid}/bodyscans/${scanId}.pdf`;
    await uploadBytes(storageRef(storage, path), file);
    btn.innerHTML = '<span class="spinner"></span> Extracting…';
    const parseBodyScan = httpsCallable(functions, "parseBodyScan");
    const result = await parseBodyScan({ scanId, storagePath: path });
    const extracted = result.data.extracted;
    uploadedScanId = scanId;
    document.getElementById("scanWeight").value = extracted.weight_kg ?? "";
    document.getElementById("scanBodyFat").value = extracted.body_fat_pct ?? "";
    const extras = [];
    if (extracted.muscle_mass_kg) extras.push(`Muscle mass: ${extracted.muscle_mass_kg}kg`);
    if (extracted.bmr_kcal) extras.push(`BMR: ${extracted.bmr_kcal}kcal`);
    if (extracted.visceral_fat_level) extras.push(`Visceral fat: ${extracted.visceral_fat_level}`);
    document.getElementById("scanExtra").textContent = extras.join(" · ");
    document.getElementById("scanReview").style.display = "block";
    showSuccess("Extracted — review and confirm below.");
  } catch (err) {
    showError(`Couldn't process that scan: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Upload & extract";
  }
});

document.getElementById("scanConfirmBtn").addEventListener("click", async () => {
  if (!uploadedScanId) return;
  const weight_kg = parseFloat(document.getElementById("scanWeight").value) || null;
  const body_fat_pct = parseFloat(document.getElementById("scanBodyFat").value) || null;
  try {
    await updateDoc(doc(db, "users", user.uid, "bodyScans", uploadedScanId), {
      "extracted.weight_kg": weight_kg,
      "extracted.body_fat_pct": body_fat_pct,
      confirmedByUser: true,
    });
    // Pre-fill the stats fields so the user doesn't retype them.
    document.getElementById("bodyweight_kg").value = weight_kg ?? "";
    document.getElementById("body_fat_pct").value = body_fat_pct ?? "";
    showSuccess("Values applied to your stats below.");
  } catch (err) {
    showError(`Couldn't save that: ${err.message || err}`);
  }
});

// Save nutrition + stats with dot-paths (athlete stats) and a nutrition object.
// Returns whether targets + meal plan can be generated.
async function saveNutritionFields() {
  const height = numOrNull("height_cm");
  const weight = numOrNull("bodyweight_kg");
  const meals = numOrNull("meals_per_day");
  await updateDoc(doc(db, "users", user.uid), {
    "athlete.height_cm": height,
    "athlete.bodyweight_kg": weight,
    "athlete.bodyweight_date": new Date().toISOString().slice(0, 10),
    "athlete.body_fat_pct": numOrNull("body_fat_pct"),
    "athlete.activity_level": strOrNull("activity_level") || "moderate",
    nutrition: {
      diet_style: strOrNull("diet_style"),
      allergies: splitList("allergies"),
      foods_to_avoid: splitList("foods_to_avoid"),
      preferred_cuisines: splitList("preferred_cuisines"),
      meals_per_day: meals,
      cooking_time_preference: strOrNull("cooking_time_preference"),
      eat_out_frequency: strOrNull("eat_out_frequency"),
      budget_preference: strOrNull("budget_preference"),
      supplements: splitList("supplements"),
    },
  });
  return Boolean(height && weight && meals);
}

document.getElementById("step3FinishBtn").addEventListener("click", async () => {
  clearMessages();
  const btn = document.getElementById("step3FinishBtn");
  btn.disabled = true;
  try {
    const canGenerate = await saveNutritionFields();
    if (canGenerate) {
      try {
        // targets must be computed before the meal plan (which reads them);
        // queueing (like the training program) returns immediately and the
        // actual generation runs in the background.
        await httpsCallable(functions, "calculateTargets")();
        await httpsCallable(functions, "queueMealPlanGeneration")();
      } catch (err) {
        showError(`Couldn't start building your meal plan: ${err.message || err}`);
        btn.disabled = false;
        return;
      }
    }
    await finishOnboarding();
  } catch (err) {
    showError(`Couldn't save your nutrition details: ${err.message || err}`);
    btn.disabled = false;
  }
});

document.getElementById("step3SkipBtn").addEventListener("click", async () => {
  const btn = document.getElementById("step3SkipBtn");
  btn.disabled = true;
  try {
    await finishOnboarding();
  } catch (err) {
    showError(`Couldn't finish: ${err.message || err}`);
    btn.disabled = false;
  }
});

/* ---------- Finishing ---------- */

async function finishOnboarding() {
  // Any generation the user asked for was already queued (and runs in the
  // background) by the step 2/3 handlers above, so there's nothing left to
  // wait on here — just mark onboarding done and head to the dashboard,
  // which shows "generating" on the relevant card until the background work
  // lands.
  for (let i = 1; i <= 3; i++) document.getElementById(`step${i}`).style.display = "none";
  document.getElementById("finishing").style.display = "block";
  clearMessages();
  window.scrollTo({ top: 0, behavior: "smooth" });

  document.getElementById("finishTitle").textContent = "All set";
  document.getElementById("finishMsg").textContent = "Taking you to your dashboard…";

  await updateDoc(doc(db, "users", user.uid), {
    "onboarding.completed": true,
    "onboarding.step": "done",
  });

  location.href = "dashboard.html";
}

/* ---------- Resume where the user left off ---------- */
(async function init() {
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const profile = snap.exists() ? snap.data() : null;
    const step = profile?.onboarding?.step;
    const startStep = { basics: 1, training: 2, nutrition: 3 }[step] || 1;
    goToStep(startStep);
  } catch (err) {
    console.error("[onboarding] failed to resume, starting from step 1", err);
    goToStep(1);
  }
})();
