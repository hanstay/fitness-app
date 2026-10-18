// The check-in's "Your week": one-tap questions about where the logs
// differed from the plan (built by functions/src/lib/checkinQuestions.ts and
// served by getCheckinQuestions). A tap saves the answer straight away as a
// note for the next plan update; tapping another answer changes it, and
// tapping the chosen one again takes it back. What the update did with each
// answer shows in What changed on the Program page, not here.
// Personal plans only, as with notes.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";
import { PAIN_SAFETY, errorText } from "./plan-feedback.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (id) => document.getElementById(id);

// Mirrors PAIN_AREAS / PAIN_LEVELS in functions/src/checkin/checkinQuestions.ts.
const PAIN_AREAS = ["Knee", "Lower back", "Hip", "Shoulder", "Elbow", "Wrist", "Ankle", "Other"];
const PAIN_LEVELS = ["A niggle", "Sore", "Sharp"];

/** The athlete's own date, so "Thursday" means their Thursday. */
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let questions = new Map(); // key → question, as last loaded
let onImport = () => {};
let loading = null;
let personal = false; // initCheckinQuestions found a personal plan

/**
 * Show the section for a personal plan and load its questions. onImportNow
 * opens the Hevy import (the "Import now" answer).
 */
export function initCheckinQuestions(summary, { onImportNow, load = true } = {}) {
  if (summary?.activeProgramSource === "group" && summary?.groupId) return;
  onImport = onImportNow ?? onImport;
  $("weekMoreBtn").addEventListener("click", () => {
    $("weekMore").hidden = !$("weekMore").hidden;
    renderMoreButton();
  });
  personal = true;
  if (load) refreshCheckinQuestions();
}

/** Reload after new data comes in (a Hevy import or an intervals.icu sync). */
export async function refreshCheckinQuestions() {
  if (!personal) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const { data } = await httpsCallable(functions, "getCheckinQuestions")({ today: localToday() });
      render(data);
    } catch (err) {
      console.error("[checkin] questions failed to load", err);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/* ---------- rendering ---------- */

let moreCount = 0;

function render({ gap, data, week, more }) {
  questions = new Map([gap, ...data, ...week, ...more].filter(Boolean).map((q) => [q.key, q]));
  $("weekSection").style.display = gap || data.length || week.length ? "" : "none";
  $("gapCard").innerHTML = gap ? card(gap, "cq-welcome") : "";
  $("dataCards").innerHTML = data.map((q) => card(q, "cq-warn")).join("");
  // A week that went to plan shows no "Your week" at all.
  $("weekBlock").style.display = week.length ? "" : "none";
  const total = week.length + more.length;
  $("weekIntro").textContent = more.length
    ? `${total} things differed from your plan. Here are the ${week.length} that matter most. One tap each, or skip them.`
    : `${total === 1 ? "1 thing" : `${total} things`} differed from your plan. One tap each, or skip them.`;
  $("weekCards").innerHTML = week.map((q) => card(q)).join("");
  $("weekMore").innerHTML = `<div class="cq-more">${more.map((q) => card(q)).join("")}</div>`;
  $("weekMore").hidden = true;
  moreCount = more.length;
  renderMoreButton();
  document.querySelectorAll("#weekSection .cq-card").forEach(bindCard);
}

function renderMoreButton() {
  const btn = $("weekMoreBtn");
  btn.style.display = moreCount ? "" : "none";
  btn.textContent = $("weekMore").hidden ? `Show ${moreCount} more` : "Show fewer";
}

function card(q, extra = "") {
  const id = (s) => `cq-${q.key.replace(/[^a-zA-Z0-9]/g, "_")}-${s}`;
  const chosen = q.answer?.answerId;
  const chosenFollowUp = q.answer?.followUpId;
  const chip = (name, value, label, checked) =>
    `<label><input type="radio" name="${esc(name)}" value="${esc(value)}"${checked ? " checked" : ""}><span>${esc(label)}</span></label>`;
  const followUp = q.answers.find((a) => a.followUp && a.id === chosen)?.followUp;
  return `<div class="cq-card ${extra}" data-key="${esc(q.key)}">
    <div class="cq-src">${esc(q.source)}</div>
    <p class="cq-text" id="${id("q")}">${esc(q.text)}</p>
    ${q.facts.length ? `<div class="cq-facts">${q.facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
    <div class="chips" role="radiogroup" aria-labelledby="${id("q")}">
      ${q.answers.map((a) => chip(id("a"), a.id, a.label, a.id === chosen)).join("")}
    </div>
    <div class="cq-follow">${followUp ? followUpHtml(q, followUp, chosenFollowUp) : ""}</div>
    <p class="status-line small" role="status"></p>
  </div>`;
}

function followUpHtml(q, followUp, chosen) {
  const name = `cq-${q.key.replace(/[^a-zA-Z0-9]/g, "_")}-f`;
  return `<fieldset><legend>${esc(followUp.text)}</legend><div class="chips">
    ${followUp.answers.map((f) => `<label><input type="radio" name="${esc(name)}" value="${esc(f.id)}"${f.id === chosen ? " checked" : ""}><span>${esc(f.label)}</span></label>`).join("")}
  </div></fieldset>`;
}

// Only pain asks for more before it's saved; every other answer is one tap.
function painHtml(q) {
  const name = (s) => `cq-${q.key.replace(/[^a-zA-Z0-9]/g, "_")}-${s}`;
  const chips = (field, values) => values.map((v) => `<label><input type="radio" name="${name(field)}" value="${esc(v)}"><span>${esc(v)}</span></label>`).join("");
  return `<fieldset><legend>Where?</legend><div class="chips" data-field="area">${chips("area", PAIN_AREAS)}</div></fieldset>
    <fieldset><legend>How bad?</legend><div class="chips" data-field="level">${chips("level", PAIN_LEVELS)}</div></fieldset>
    <div class="callout warn small">${esc(PAIN_SAFETY)}</div>
    <fieldset><legend>Work around it</legend><div class="seg" data-field="duration">
      <label><input type="radio" name="${name("dur")}" value="week" checked><span>This week</span></label>
      <label><input type="radio" name="${name("dur")}" value="ongoing"><span>Until it's better</span></label>
    </div></fieldset>
    ${detailsHtml(q, "Anything to add? (optional)")}`;
}

function detailsHtml(q, label) {
  const id = `cq-${q.key.replace(/[^a-zA-Z0-9]/g, "_")}-text`;
  return `<div class="field" style="margin:0"><label for="${id}">${esc(label)}</label>
      <textarea class="input" id="${id}" maxlength="1000" rows="2"></textarea></div>
    <button class="btn secondary" type="button" data-save>Save</button>`;
}

/* ---------- answering ---------- */

function bindCard(el) {
  const q = questions.get(el.dataset.key);
  if (!q) return;
  const status = (msg) => { el.querySelector(".status-line").textContent = msg; };
  const follow = el.querySelector(".cq-follow");

  const save = async (answerId, extra = {}) => {
    el.querySelectorAll("input, button, textarea").forEach((c) => { c.disabled = true; });
    status("Saving…");
    try {
      const { data } = await httpsCallable(functions, "answerCheckinQuestion")({ key: q.key, answerId, today: localToday(), ...extra });
      q.answer = { noteId: data.noteId, answerId, followUpId: extra.followUpId ?? null };
      // The pain questions or the text box close once saved; a follow-up stays, showing its answer.
      if (extra.pain || "text" in extra) follow.innerHTML = "";
      status("Saved for your next plan update.");
    } catch (err) {
      status(errorText(err));
    } finally {
      el.querySelectorAll("input, button, textarea").forEach((c) => { c.disabled = false; });
    }
  };

  // Tapping the chosen answer again takes it back.
  el.querySelectorAll(":scope > .chips input").forEach((input) => {
    input.addEventListener("click", async () => {
      if (q.answer?.answerId === input.value) {
        input.checked = false;
        follow.innerHTML = "";
        status("Removing…");
        try {
          await httpsCallable(functions, "removeFeedbackNote")({ noteId: q.answer.noteId });
          q.answer = null;
          status("");
        } catch (err) {
          input.checked = true;
          status(errorText(err));
        }
      }
    });
    input.addEventListener("change", () => answer(input.value));
  });

  function answer(answerId) {
    const a = q.answers.find((x) => x.id === answerId);
    if (!a) return;
    status("");
    if (a.action === "import") { follow.innerHTML = ""; onImport(); return; }
    if (a.action === "dismiss") { el.remove(); return; }
    if (a.followUp) {
      follow.innerHTML = followUpHtml(q, a.followUp, null);
      follow.querySelectorAll("input").forEach((f) => f.addEventListener("change", () => save(answerId, { followUpId: f.value })));
      return;
    }
    if (a.pain || a.details) {
      follow.innerHTML = a.pain ? painHtml(q) : detailsHtml(q, "Anything to add? (optional)");
      follow.querySelector("[data-save]").addEventListener("click", () => {
        const pick = (field) => follow.querySelector(`[data-field="${field}"] input:checked`)?.value;
        const text = follow.querySelector("textarea")?.value.trim() || "";
        if (a.pain) {
          if (!pick("area") || !pick("level")) return status("Say where it hurts and how bad it is.");
          save(answerId, { pain: { area: pick("area"), level: pick("level"), duration: pick("duration") || "week", text } });
        } else {
          save(answerId, { text });
        }
      });
      return;
    }
    follow.innerHTML = "";
    save(answerId);
  }
}
