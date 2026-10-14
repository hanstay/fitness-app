// Weekly check-in view: import Hevy → sync intervals.icu → regenerate program.
// One-shot reads (plus one listener for the plan update's background status),
// per-page message boxes, dot-path writes — matching the conventions in
// dashboard.html / onboarding-wizard.js.
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { db, functions } from "./firebase-init.js";
import { analyzeHevyCsv } from "./generated/hevy-checkin.js";
import { requireOnboarded } from "./auth-guard.js";
import { connectIntervalsIcuViaOAuth } from "./intervals-oauth.js";
import { bindMessages } from "./ui-messages.js";
import { isStale } from "./plan-updates.js";

const session = await requireOnboarded();
if (!session) throw new Error("redirecting"); // requireOnboarded already redirected
const { user } = session;

/* ---------- shared helpers ---------- */

const { showError, showSuccess, clearMessages } = bindMessages();
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const setStatus = (id, msg) => { document.getElementById(id).textContent = msg; };

// Guards a control that fires a side-effectful / costly API call. The control is
// clickable ONLY before its first send (idle) or after a failed attempt (retry).
// While the request is in flight — and after it succeeds — the control stays
// disabled, so an expensive call (saveHevySessions, credential writes) can't be
// double-fired or spammed. Reload the page to run it again after a success.
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
const fmtDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// Kept deliberately short: the program page is where the athlete reads
// coaching after the plan update, so this only confirms what was imported.
// Plan adherence isn't shown; generation compares the log with the plan itself.
function renderImportSummary(container, sessionsImported, progression) {
  const plural = sessionsImported === 1 ? "" : "s";
  const range = progression?.dateRange ? ` from ${esc(fmtDate(progression.dateRange.first))} to ${esc(fmtDate(progression.dateRange.last))}` : "";
  const lifts = (progression?.keyLifts || []).slice(0, 5).map((l) => {
    const trend = l.trend ? ` <span class="${TREND_CLASS[l.trend.direction] || ""}">${l.trend.direction}</span>` : "";
    return `<li><b>${esc(l.exercise)}</b> ${l.currentE1RM}kg${trend}</li>`;
  }).join("");
  container.innerHTML = `
    <p class="small">${sessionsImported} session${plural}${range}.</p>
    ${lifts ? `<p class="muted small" style="margin-bottom:4px">Estimated 1-rep max for your main lifts:</p><ul class="small">${lifts}</ul>` : ""}`;
  container.style.display = "block";
}

// The CSV is parsed and analyzed here in the browser, so the results show
// straight away; only the parsed sessions go to the server to be saved.
document.getElementById("hevyUploadBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const file = document.getElementById("hevyFile").files[0];
  if (!file) return showError("Choose a Hevy CSV export first.");
  clearMessages();
  setStatus("hevyStatus", "Analyzing…");
  withButtonBusy(btn, "Analyzing…", async () => {
    const { sessions, lifts, progression } = analyzeHevyCsv(await file.text());
    renderImportSummary(document.getElementById("hevyResults"), sessions.length, progression);

    setStatus("hevyStatus", "Saving…");
    await httpsCallable(functions, "saveHevySessions")({ sessions, lifts });
    setStatus("hevyStatus", "Saved. Update your plan below when you're ready.");
  }).catch((err) => {
    setStatus("hevyStatus", "");
    showError(`Couldn't import that CSV: ${err.message || err}`);
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
  clearMessages();
  setStatus("icuConnectStatus", "Connecting…");
  withButtonBusy(e.currentTarget, "Connecting…", async () => {
    const result = await connectIntervalsIcuViaOAuth();
    setStatus("icuConnectStatus", "");
    if (result.cancelled) return;
    if (result.syncError) {
      showError(`Connected, but the first sync failed: ${result.syncError}`);
    } else {
      showSuccess(`Connected — synced ${result.activitiesSynced ?? 0} recent activities.`);
    }
    summary = await loadSummary();
    renderIcuState(summary);
  }).catch((err) => {
    setStatus("icuConnectStatus", "");
    showError(`Couldn't connect to intervals.icu: ${err.message || err}`);
  });
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

// The update runs in the background (see queueProgramGeneration.ts), so a
// click only queues it. The summary listener owns the button and status line:
// disabled while a generation is in flight, wherever it was started, then how
// it ended; the new plan itself is on the program page.
const regenBtn = document.getElementById("regenBtn");
const regenLabel = regenBtn.innerHTML;
const UPDATING_MSG = "Updating your plan. You can leave this page; it'll be ready on your dashboard in a few minutes.";
const STALLED_MSG = "This update seems to have stalled. Please try again.";

let queuing = false;    // the queue call itself is in flight
let followingId = null; // the generation whose outcome this page reports
let latestSummary = null;

regenBtn.addEventListener("click", async () => {
  if (regenBtn.disabled) return;
  clearMessages();
  queuing = true;
  renderGenerationStatus();
  try {
    const force = document.getElementById("forceRegenCheck")?.checked === true;
    const result = await httpsCallable(functions, "queueProgramGeneration")({ force });
    followingId = result.data.programId;
  } catch (err) {
    const msg = String(err?.message || err);
    const isPrecondition = /first|required|Complete/i.test(msg);
    showError(isPrecondition
      ? "Add your training details (days/week, session length) in your profile first."
      : `Couldn't update your program: ${msg}`);
  } finally {
    queuing = false;
    renderGenerationStatus();
  }
});

// Outcomes are matched to the generation by the summary's
// programGenerationId, so a snapshot from before the queue's write isn't
// taken for the end of the new generation, and an error left over from an
// earlier attempt isn't shown again on every visit.
function renderGenerationStatus() {
  const s = latestSummary;
  const inFlight = s?.programGenerationStatus === "generating" && !isStale(s.programGenerationStartedAt);
  regenBtn.disabled = queuing || inFlight;
  regenBtn.innerHTML = queuing ? `<span class="spinner"></span> Starting…` : regenLabel;
  const statusEl = document.getElementById("regenStatus");
  // A live region: only touch it when the text changes, so it isn't
  // re-announced on every snapshot.
  const setStatusText = (text) => { if (statusEl.textContent !== text) statusEl.textContent = text; };
  if (inFlight) {
    // A newer generation (e.g. from another tab) replaces a stalled one.
    followingId = s.programGenerationId ?? followingId;
    setStatusText(UPDATING_MSG);
  } else if (followingId && s?.programGenerationId === followingId) {
    if (s.programGenerationStatus === "generating") {
      // Stalled: keep following it, so the stale sweep's error still shows.
      setStatusText(STALLED_MSG);
    } else if (s.programGenerationStatus === "error") {
      followingId = null;
      setStatusText("");
      showError(`Couldn't update your program: ${s.programGenerationError || "unknown error"}`);
    } else {
      followingId = null;
      statusEl.innerHTML = `Your plan is updated. <a href="program.html">See your updated plan →</a>`;
    }
  } else if (statusEl.textContent === UPDATING_MSG) {
    setStatusText(""); // one whose outcome isn't ours to report (no id, or stalled)
  }
}

/* ---------- init ---------- */

onSnapshot(doc(db, "users", user.uid, "state", "summary"), (snap) => {
  latestSummary = snap.data();
  renderGenerationStatus();
}, (err) => console.error("[checkin] plan update status listener failed", err));

async function loadSummary() {
  const snap = await getDoc(doc(db, "users", user.uid, "state", "summary"));
  return snap.exists() ? snap.data() : null;
}

let summary = null;
try {
  summary = await loadSummary();
  renderIcuState(summary);
} catch (err) {
  console.error("[checkin] failed to load summary", err);
  showError("Couldn't load your intervals.icu status — Hevy import and program updates below still work.");
}

// Fire-and-forget: runs in parallel with the user's own Hevy CSV export/
// upload instead of adding latency later, at "Update my plan" time.
if (summary?.integrationsStatus?.intervalsIcu?.connected) {
  httpsCallable(functions, "syncIntervalsActivities")()
    .then(async () => {
      summary = await loadSummary();
      renderIcuState(summary);
    })
    .catch(async (err) => {
      console.error("[checkin] background intervals.icu sync failed", err);
      try {
        summary = await loadSummary();
        renderIcuState(summary);
      } catch {
        // Re-render attempt failed too — the original console.error above
        // already logged the underlying sync failure; nothing more to do.
      }
    });
}
