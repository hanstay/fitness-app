// Weekly check-in view: import Hevy → sync intervals.icu → regenerate program.
// One-shot reads only (no listeners), per-page message boxes, dot-path writes —
// matching the conventions in dashboard.html / onboarding-wizard.js.
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { ref as storageRef, uploadBytes } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-storage.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { db, storage, functions } from "./firebase-init.js";
import { requireOnboarded } from "./auth-guard.js";

const session = await requireOnboarded();
if (!session) throw new Error("redirecting"); // requireOnboarded already redirected
const { user } = session;

/* ---------- shared helpers ---------- */

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
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const setStatus = (id, msg) => { document.getElementById(id).textContent = msg; };

// Guards a control that fires a side-effectful / costly API call. The control is
// clickable ONLY before its first send (idle) or after a failed attempt (retry).
// While the request is in flight — and after it succeeds — the control stays
// disabled, so an expensive call (generateProgram, parseHevyCsv, credential
// writes) can't be double-fired or spammed. Reload the page to run it again
// after a success.
async function withButtonBusy(btn, busyLabel, fn) {
  if (btn.disabled) return; // already in flight, or completed successfully
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${busyLabel}`;
  try {
    const result = await fn();
    btn.innerHTML = original; // success → leave DISABLED (not clickable again)
    return result;
  } catch (err) {
    btn.disabled = false;     // failed to complete → clickable again to retry
    btn.innerHTML = original;
    throw err;
  }
}

/* ---------- collapsible sections ---------- */

document.querySelectorAll("section.collapsible > .sec-head").forEach((head) => {
  head.addEventListener("click", () => head.parentElement.classList.toggle("collapsed"));
});
function expandSection(sectionId) {
  document.getElementById(sectionId).classList.remove("collapsed");
}

/* ---------- Section 1: Hevy import ---------- */

const TREND_CLASS = { "↑": "trend-up", "→": "trend-flat", "↓": "trend-down" };

function renderProgression(container, progression, sessionsImported) {
  if (!progression) {
    container.innerHTML = `<p class="muted small">Imported ${sessionsImported} session${sessionsImported === 1 ? "" : "s"}. Not enough data yet to chart progression.</p>`;
    container.style.display = "block";
    return;
  }
  const { dateRange, frequencyPerWeek, keyLifts } = progression;
  const rangeStr = dateRange ? `${esc(dateRange.first)} — ${esc(dateRange.last)}` : "";

  const rows = (keyLifts || []).slice(0, 8).map((l) => {
    const pr = l.pr ? `${l.pr.weight_kg}kg <span class="muted small">(${esc(l.pr.date)})</span>` : "—";
    const trend = l.trend
      ? `<span class="${TREND_CLASS[l.trend.direction] || ""}">${l.trend.direction} ${l.trend.percent_change > 0 ? "+" : ""}${l.trend.percent_change}%</span>`
      : "<span class=\"muted\">—</span>";
    return `<tr>
      <td><b>${esc(l.exercise)}</b></td>
      <td class="n">${l.currentE1RM}kg</td>
      <td class="n">${pr}</td>
      <td>${trend}</td>
      <td class="muted small">${esc(l.lastTrained || "—")}</td>
    </tr>`;
  }).join("");

  container.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">Sessions imported</div><div class="v">${sessionsImported}</div></div>
      <div class="stat"><div class="k">Frequency</div><div class="v">${frequencyPerWeek}/wk</div></div>
      <div class="stat"><div class="k">Date range</div><div class="v" style="font-size:.9rem">${rangeStr}</div></div>
    </div>
    ${rows ? `<h3>Key lifts (e1RM)</h3>
      <div class="tablescroll"><table>
        <thead><tr><th>Exercise</th><th class="n">Current</th><th class="n">PR</th><th>6-week trend</th><th>Last trained</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="note">e1RM = estimated 1-rep max (Epley). Trend compares your oldest vs newest lift in the last 6 weeks.</p>`
      : `<p class="muted small">No scorable barbell/weighted lifts found to chart yet.</p>`}`;
  container.style.display = "block";
}

document.getElementById("hevyUploadBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const file = document.getElementById("hevyFile").files[0];
  if (!file) return showError("Choose a Hevy CSV export first.");
  clearMessages();
  setStatus("hevyStatus", "Uploading and analyzing…");
  withButtonBusy(btn, "Analyzing…", async () => {
    const path = `users/${user.uid}/hevy/latest.csv`;
    await uploadBytes(storageRef(storage, path), file);
    const parseHevy = httpsCallable(functions, "parseHevyCsv");
    const result = await parseHevy({ storagePath: path });
    const { sessionsImported, progression } = result.data;
    setStatus("hevyStatus", "");
    renderProgression(document.getElementById("hevyResults"), progression, sessionsImported ?? 0);
    showSuccess(`Imported ${sessionsImported ?? 0} training session${sessionsImported === 1 ? "" : "s"}.`);
    document.getElementById("hevyResults").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }).catch((err) => {
    setStatus("hevyStatus", "");
    showError(`Couldn't process that CSV: ${err.message || err}`);
  });
});

/* ---------- Section 2: intervals.icu ---------- */

function renderWellness(wellness) {
  const el = document.getElementById("icuWellness");
  if (!wellness) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="stat"><div class="k">Fitness (CTL)</div><div class="v">${wellness.ctl}</div></div>
    <div class="stat"><div class="k">Fatigue (ATL)</div><div class="v">${wellness.atl}</div></div>
    <div class="stat"><div class="k">Form (TSB)</div><div class="v ${wellness.tsb < -10 ? "warn" : ""}">${wellness.tsb}</div></div>`;
}

function tsAgo(ts) {
  const d = ts?.toDate ? ts.toDate() : null;
  return d ? `Last synced ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
}

function renderIcuState(summary) {
  const icu = summary?.integrationsStatus?.intervalsIcu;
  const connected = Boolean(icu?.connected);
  document.getElementById("icuConnected").style.display = connected ? "block" : "none";
  document.getElementById("icuDisconnected").style.display = connected ? "none" : "block";
  if (connected) {
    document.getElementById("icuLastSync").textContent = tsAgo(icu.lastSyncedAt);
    renderWellness(summary?.wellness);
    // Surface connected users' load without making them expand the card.
    expandSection("icuSection");
  }
}

document.getElementById("icuConnectBtn").addEventListener("click", (e) => {
  const athleteId = document.getElementById("icuAthleteId").value.trim();
  const apiKey = document.getElementById("icuApiKey").value.trim();
  if (!athleteId || !apiKey) return showError("Enter both your athlete ID and API key.");
  clearMessages();
  setStatus("icuConnectStatus", "Verifying and syncing…");
  withButtonBusy(e.currentTarget, "Connecting…", async () => {
    const saveCreds = httpsCallable(functions, "saveIntervalsIcuCredentials");
    const result = await saveCreds({ athleteId, apiKey });
    setStatus("icuConnectStatus", "");
    showSuccess(`Connected — synced ${result.data.activitiesSynced ?? 0} recent activities.`);
    summary = await loadSummary();
    renderIcuState(summary);
  }).catch((err) => {
    setStatus("icuConnectStatus", "");
    showError(`Couldn't connect to intervals.icu: ${err.message || err}`);
  });
});

// Reveal the credential form from the connected state so keys can be replaced
// (expired/rotated key, or a stale connected flag with no stored credential).
document.getElementById("icuUpdateKeysBtn").addEventListener("click", () => {
  const icu = summary?.integrationsStatus?.intervalsIcu;
  const form = document.getElementById("icuDisconnected");
  form.style.display = "block";
  if (icu?.athleteId) document.getElementById("icuAthleteId").value = icu.athleteId;
  document.getElementById("icuApiKey").value = "";
  // Deliberately re-opening the form is a fresh "not sent yet" — clear any
  // disabled state left by an earlier successful connect so keys can be resent.
  document.getElementById("icuConnectBtn").disabled = false;
  document.getElementById("icuApiKey").focus();
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

document.getElementById("icuSyncBtn").addEventListener("click", (e) => {
  clearMessages();
  setStatus("icuStatus", "Syncing…");
  withButtonBusy(e.currentTarget, "Syncing…", async () => {
    const result = await httpsCallable(functions, "syncIntervalsActivities")();
    setStatus("icuStatus", `Synced ${result.data.activitiesSynced ?? 0} activities.`);
    summary = await loadSummary();
    renderIcuState(summary);
  }).catch((err) => {
    setStatus("icuStatus", "");
    showError(`Sync failed: ${err.message || err}`);
  });
});

/* ---------- Section 3: regenerate program ---------- */

function renderPlanUpdated(program) {
  const container = document.getElementById("planUpdatedContainer");
  const cs = program.currentState;
  const weekly = (program.weeklyStructure || []).map((d) =>
    `<div class="ex"><div class="row"><span class="name">${esc(d.day)}</span><span class="sets">${esc(d.focus)}</span></div>${d.note ? `<div class="note">${esc(d.note)}</div>` : ""}</div>`
  ).join("");
  const highlights = (cs?.highlights || []).length
    ? `<h3>What changed</h3><ul>${cs.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>`
    : "";
  const summaryLine = cs?.summary ? `<p>${esc(cs.summary)}</p>` : "";
  const coach = program.coachNotes ? `<div class="callout warn">${esc(program.coachNotes)}</div>` : "";

  container.innerHTML = `
    <section id="planUpdated">
      <h2><span class="dot"></span>Your program is updated ✓</h2>
      <div class="badges" style="margin-bottom:12px">
        <span class="badge">🏋️ <b>${esc(program.split || "Program")}</b></span>
        <span class="badge"><b>${esc(program.daysPerWeek ?? "?")}</b> days/week</span>
      </div>
      <p><b>${esc(program.title || "Updated program")}</b>${program.goalSummary ? ` — ${esc(program.goalSummary)}` : ""}</p>
      ${summaryLine}${highlights}
      ${weekly ? `<h3>Weekly structure</h3>${weekly}` : ""}
      ${coach}
      <a class="btn full" href="program.html" style="margin-top:6px">View full plan →</a>
    </section>`;
  container.querySelector("#planUpdated").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("regenBtn").addEventListener("click", (e) => {
  clearMessages();
  document.getElementById("planUpdatedContainer").innerHTML = "";
  setStatus("regenStatus", "Rebuilding your program — this can take a couple of minutes…");
  withButtonBusy(e.currentTarget, "Rebuilding…", async () => {
    const result = await httpsCallable(functions, "generateProgram", { timeout: 300000 })();
    setStatus("regenStatus", "");
    showSuccess("Your program is ready.");
    renderPlanUpdated(result.data);
  }).catch((err) => {
    const msg = String(err?.message || err);
    const isPrecondition = /first|required|Complete/i.test(msg);
    setStatus("regenStatus", "");
    showError(isPrecondition
      ? "Add your training details (days/week, session length) in your profile first."
      : `Couldn't rebuild your program: ${msg}`);
  });
});

/* ---------- init ---------- */

async function loadSummary() {
  const snap = await getDoc(doc(db, "users", user.uid, "state", "summary"));
  return snap.exists() ? snap.data() : null;
}

let summary = await loadSummary();
renderIcuState(summary);
