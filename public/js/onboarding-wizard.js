import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { ref as storageRef, uploadBytes } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-storage.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { db, storage, functions } from "./firebase-init.js";
import { requireAuth } from "./auth-guard.js";

const user = await requireAuth();
if (!user) throw new Error("not authenticated"); // requireAuth already redirected

let currentStep = 1;
let uploadedScanId = null;

const errorBox = document.getElementById("errorBox");
const successBox = document.getElementById("successBox");
const stepSub = document.getElementById("stepSub");

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

function goToStep(n) {
  currentStep = n;
  for (let i = 1; i <= 4; i++) {
    document.getElementById(`step${i}`).style.display = i === n ? "block" : "none";
  }
  document.querySelectorAll(".step-indicator .step").forEach((el, idx) => {
    const stepNum = idx + 1;
    el.classList.toggle("done", stepNum < n);
    el.classList.toggle("active", stepNum === n);
  });
  const labels = {
    1: "Step 1 of 4 — Body scan (optional)",
    2: "Step 2 of 4 — Connect your data (optional)",
    3: "Step 3 of 4 — Your profile",
    4: "Step 4 of 4 — Review & generate",
  };
  stepSub.textContent = labels[n];
  clearMessages();
  updateDoc(doc(db, "users", user.uid), { "onboarding.step": ["scan", "integrations", "profile", "review"][n - 1] }).catch(() => {});
}

/* ---------- Step 1: Body scan ---------- */

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
    await updateDoc(doc(db, "users", user.uid), {
      "athlete.bodyweight_kg": weight_kg,
      "athlete.bodyweight_date": new Date().toISOString().slice(0, 10),
      "athlete.body_fat_pct": body_fat_pct,
    });
    // Pre-fill step 3 fields for when the user gets there.
    document.getElementById("bodyweight_kg").value = weight_kg ?? "";
    document.getElementById("body_fat_pct").value = body_fat_pct ?? "";
    goToStep(2);
  } catch (err) {
    showError(`Couldn't save that: ${err.message || err}`);
  }
});

document.getElementById("skipScan").addEventListener("click", (e) => {
  e.preventDefault();
  goToStep(2);
});

/* ---------- Step 2: Connect data ---------- */

document.getElementById("icuConnectBtn").addEventListener("click", async () => {
  const athleteId = document.getElementById("icuAthleteId").value.trim();
  const apiKey = document.getElementById("icuApiKey").value.trim();
  const status = document.getElementById("icuStatus");
  if (!athleteId || !apiKey) return showError("Enter both your athlete ID and API key.");
  clearMessages();
  status.textContent = "Verifying and syncing…";
  const btn = document.getElementById("icuConnectBtn");
  btn.disabled = true;
  try {
    const saveCreds = httpsCallable(functions, "saveIntervalsIcuCredentials");
    const result = await saveCreds({ athleteId, apiKey });
    status.textContent = `Connected — synced ${result.data.activitiesSynced ?? 0} recent activities.`;
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

document.getElementById("step2ContinueBtn").addEventListener("click", () => goToStep(3));

/* ---------- Step 3: Profile form ---------- */

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

let eventRowCount = 0;
document.getElementById("addEventBtn").addEventListener("click", () => {
  eventRowCount++;
  const row = document.createElement("div");
  row.className = "field";
  row.dataset.eventRow = eventRowCount;
  row.innerHTML = `
    <div style="display:flex; gap:8px; align-items:center">
      <input class="input" type="text" placeholder="Event name" style="flex:2" data-event-name>
      <input class="input" type="date" style="flex:1" data-event-date>
      <button type="button" class="btn secondary" data-remove-event style="padding:8px 12px">×</button>
    </div>`;
  row.querySelector("[data-remove-event]").addEventListener("click", () => row.remove());
  document.getElementById("eventsList").appendChild(row);
});

document.getElementById("step3ContinueBtn").addEventListener("click", async () => {
  clearMessages();
  const events = Array.from(document.querySelectorAll("#eventsList [data-event-row]"))
    .map((row) => ({
      name: row.querySelector("[data-event-name]").value.trim(),
      date: row.querySelector("[data-event-date]").value,
    }))
    .filter((e) => e.name && e.date);

  const update = {
    athlete: {
      sex: strOrNull("sex"),
      age: numOrNull("age"),
      height_cm: numOrNull("height_cm"),
      bodyweight_kg: numOrNull("bodyweight_kg"),
      bodyweight_date: new Date().toISOString().slice(0, 10),
      body_fat_pct: numOrNull("body_fat_pct"),
      activity_level: strOrNull("activity_level"),
      equipment: splitList("equipment"),
      training_days_per_week: numOrNull("training_days_per_week"),
      session_length_minutes: numOrNull("session_length_minutes"),
      preferred_split: strOrNull("preferred_split"),
      training_experience_years: numOrNull("training_experience_years"),
      injuries_constraints: document.getElementById("injuries_constraints").value.trim().slice(0, 2000),
      events,
      goal: document.getElementById("goal").value.trim().slice(0, 1000),
      current_lifts: [],
      recovery: {
        sleep_hours: numOrNull("sleep_hours"),
        sleep_quality: strOrNull("sleep_quality"),
        stress_1_10: numOrNull("stress_1_10"),
      },
    },
    nutrition: {
      diet_style: strOrNull("diet_style"),
      allergies: splitList("allergies"),
      foods_to_avoid: splitList("foods_to_avoid"),
      preferred_cuisines: splitList("preferred_cuisines"),
      meals_per_day: numOrNull("meals_per_day"),
      cooking_time_preference: strOrNull("cooking_time_preference"),
      eat_out_frequency: strOrNull("eat_out_frequency"),
      budget_preference: strOrNull("budget_preference"),
      supplements: splitList("supplements"),
    },
  };

  if (!update.athlete.sex || !update.athlete.age || !update.athlete.height_cm || !update.athlete.bodyweight_kg) {
    return showError("Sex, age, height, and weight are required to calculate your targets.");
  }

  const btn = document.getElementById("step3ContinueBtn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "users", user.uid), update);
    goToStep(4);
  } catch (err) {
    showError(`Couldn't save your profile: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Step 4: Review & generate ---------- */

let targetsCalculated = false;
let programGenerated = false;
let mealsGenerated = false;

function updateFinishButton() {
  document.getElementById("finishBtn").disabled = !(targetsCalculated && programGenerated && mealsGenerated);
}

document.getElementById("calcTargetsBtn").addEventListener("click", async () => {
  clearMessages();
  const btn = document.getElementById("calcTargetsBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Calculating…';
  try {
    const calc = httpsCallable(functions, "calculateTargets");
    const result = await calc();
    const t = result.data;
    const resultBox = document.getElementById("targetsResult");
    resultBox.innerHTML = `
      <span class="badge"><b>${t.target_calories}</b> kcal</span>
      <span class="badge"><b>${t.protein_g}g</b> protein</span>
      <span class="badge"><b>${t.carbs_g}g</b> carbs</span>
      <span class="badge"><b>${t.fat_g}g</b> fat</span>`;
    resultBox.style.display = "flex";
    document.getElementById("generateBlock").style.display = "block";
    targetsCalculated = true;
    updateFinishButton();
  } catch (err) {
    showError(`Couldn't calculate targets: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calculate targets";
  }
});

document.getElementById("genProgramBtn").addEventListener("click", async () => {
  clearMessages();
  const btn = document.getElementById("genProgramBtn");
  const status = document.getElementById("genStatus");
  btn.disabled = true;
  status.textContent = "Generating your program — this can take up to 30 seconds…";
  try {
    const gen = httpsCallable(functions, "generateProgram");
    await gen();
    status.textContent = "Program generated.";
    programGenerated = true;
    updateFinishButton();
  } catch (err) {
    status.textContent = "";
    showError(`Couldn't generate a program: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("genMealsBtn").addEventListener("click", async () => {
  clearMessages();
  const btn = document.getElementById("genMealsBtn");
  const status = document.getElementById("genStatus");
  btn.disabled = true;
  status.textContent = "Generating your meal plan — this can take up to 30 seconds…";
  try {
    const gen = httpsCallable(functions, "generateMealPlan");
    await gen();
    status.textContent = "Meal plan generated.";
    mealsGenerated = true;
    updateFinishButton();
  } catch (err) {
    status.textContent = "";
    showError(`Couldn't generate a meal plan: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("finishBtn").addEventListener("click", async () => {
  await updateDoc(doc(db, "users", user.uid), {
    "onboarding.completed": true,
    "onboarding.step": "done",
  });
  location.href = "dashboard.html";
});

/* ---------- Resume where the user left off ---------- */
(async function init() {
  const snap = await getDoc(doc(db, "users", user.uid));
  const profile = snap.exists() ? snap.data() : null;
  const step = profile?.onboarding?.step;
  const startStep = { scan: 1, integrations: 2, profile: 3, review: 4 }[step] || 1;
  goToStep(startStep);
})();
