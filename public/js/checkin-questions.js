// The check-in's "Your week": one-tap questions about where the logs
// differed from the plan (built by functions/src/lib/checkinQuestions.ts and
// served by getCheckinQuestions), asked one at a time, most important first.
// A tap saves the answer straight away as a note for the next plan update and
// brings up the next question; "Change" reopens an answer, and tapping the
// chosen one again takes it back. What the update did with each
// answer shows in What changed on the Program page, not here.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";
import { PAIN_SAFETY, errorText } from "./plan-feedback.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (id) => document.getElementById(id);

// Mirrors PAIN_AREAS / PAIN_LEVELS in functions/src/checkin/checkinQuestions.ts.
const PAIN_AREAS = ["Knee", "Lower back", "Hip", "Shoulder", "Elbow", "Wrist", "Ankle", "Other"];
const PAIN_LEVELS = ["A niggle", "Sore", "Sharp"];

/** The athlete's own date and time zone, so "Thursday" means their Thursday. */
const clock = () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { today, tzOffset: d.getTimezoneOffset() };
};

let questions = new Map(); // key → question, as last loaded
let queue = []; // every question, most important first
let onImport = () => {};
let onRemaining = () => {};
let loading = null;
let started = false; // initCheckinQuestions has run
const expanded = new Set(); // answered questions opened again with "Change"

// Skipped questions stay skipped for the day on this device (sessionStorage
// can throw in private mode; then they just come back on reload).
const SKIP_KEY = () => `checkinSkipped:${clock().today}`;
const skipped = new Set((() => { try { return JSON.parse(sessionStorage.getItem(SKIP_KEY()) || "[]"); } catch { return []; } })());
const saveSkipped = () => { try { sessionStorage.setItem(SKIP_KEY(), JSON.stringify([...skipped])); } catch { /* see above */ } };

/**
 * Load the questions (the section shows once there are some). onImportNow
 * opens the Hevy import (the "Import now" answer). onRemainingChange(n)
 * hears how many questions are still waiting for an answer or a skip, so the
 * page can hold the note form back until they're done.
 */
export function initCheckinQuestions({ onImportNow, onRemainingChange, load = true } = {}) {
  onImport = onImportNow ?? onImport;
  onRemaining = onRemainingChange ?? onRemaining;
  $("weekSkippedBtn").addEventListener("click", () => {
    skipped.clear();
    saveSkipped();
    renderQueue();
  });
  started = true;
  if (load) refreshCheckinQuestions();
}

/** Reload after new data comes in (a Hevy import or an intervals.icu sync). */
export async function refreshCheckinQuestions() {
  if (!started) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const { data } = await httpsCallable(functions, "getCheckinQuestions")(clock());
      render(data);
    } catch (err) {
      console.error("[checkin] questions failed to load", err);
      onRemaining(0); // don't hold the note form back for questions that won't come
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/* ---------- rendering ---------- */

// One question at a time, most important first: the welcome back, then the
// data checks, then the week's. Answered ones fold into a line (with
// "Change"); answering or skipping brings up the next.
function render({ gap, data, week, more }) {
  queue = [gap, ...data, ...week, ...more].filter(Boolean);
  questions = new Map(queue.map((q) => [q.key, q]));
  renderQueue();
}

const waiting = (q) => !q.answer && !skipped.has(q.key);

function renderQueue() {
  const current = queue.find(waiting);
  const remaining = queue.filter(waiting).length;
  $("weekSection").style.display = queue.some((q) => q.answer || waiting(q)) ? "" : "none";
  $("weekIntro").textContent = remaining
    ? `${remaining === 1 ? "1 question" : `${remaining} questions`} about how your week went. One tap each, or skip.`
    : "That's everything. Your answers go into your next plan update.";
  $("weekCards").innerHTML = queue.map((q) => {
    if (q.answer && !expanded.has(q.key)) return doneRow(q);
    if (q === current || (q.answer && expanded.has(q.key))) {
      return card(q, q.kind === "long_gap" ? "cq-welcome" : q.kind === "no_new_data" || q.kind === "odd_entry" ? "cq-warn" : "");
    }
    return "";
  }).join("");
  const skippedCount = queue.filter((q) => !q.answer && skipped.has(q.key)).length;
  const btn = $("weekSkippedBtn");
  btn.style.display = skippedCount ? "" : "none";
  btn.textContent = `Show the ${skippedCount === 1 ? "question" : `${skippedCount} questions`} you skipped`;
  document.querySelectorAll("#weekCards .cq-card").forEach(bindCard);
  document.querySelectorAll("#weekCards [data-change]").forEach((b) => b.addEventListener("click", () => {
    expanded.add(b.dataset.change);
    renderQueue();
  }));
  onRemaining(remaining);
}

function answerLabel(q) {
  const a = q.answers.find((x) => x.id === q.answer.answerId);
  const f = a?.followUp?.answers.find((x) => x.id === q.answer.followUpId);
  return [a?.label, f?.label].filter(Boolean).join(": ");
}

function doneRow(q) {
  return `<div class="cq-done"><span class="tick" aria-hidden="true">✓</span>
    <span class="what">${esc(q.text)} <b>${esc(answerLabel(q))}</b></span>
    <button class="link-btn" type="button" data-change="${esc(q.key)}">Change</button></div>`;
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
    ${q.answer
      ? `<button class="link-btn cq-skip" type="button" data-collapse>Done</button>`
      : `<button class="link-btn cq-skip" type="button" data-skip>Skip</button>`}
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
      const { data } = await httpsCallable(functions, "answerCheckinQuestion")({ key: q.key, answerId, ...clock(), ...extra });
      q.answer = { noteId: data.noteId, answerId, followUpId: extra.followUpId ?? null };
      // Saved: it folds into its line and the next question comes up.
      expanded.delete(q.key);
      renderQueue();
    } catch (err) {
      status(errorText(err));
    } finally {
      el.querySelectorAll("input, button, textarea").forEach((c) => { c.disabled = false; });
    }
  };

  const skip = () => {
    skipped.add(q.key);
    saveSkipped();
    renderQueue();
  };
  el.querySelector("[data-skip]")?.addEventListener("click", skip);
  el.querySelector("[data-collapse]")?.addEventListener("click", () => {
    expanded.delete(q.key);
    renderQueue();
  });

  // A saved answer's follow-up is already on the card; changing it saves.
  const bindFollowUp = (answerId) => follow.querySelectorAll("input").forEach((f) =>
    f.addEventListener("change", () => save(answerId, { followUpId: f.value })));
  if (q.answer) bindFollowUp(q.answer.answerId);

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
          expanded.delete(q.key);
          renderQueue();
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
    if (a.action === "dismiss") { skip(); return; }
    if (a.followUp) {
      follow.innerHTML = followUpHtml(q, a.followUp, null);
      bindFollowUp(answerId);
      if (q.answer) status("Not saved yet: pick one to change your answer.");
      return;
    }
    if (a.pain || a.details) {
      follow.innerHTML = a.pain ? painHtml(q) : detailsHtml(q, "Anything to add? (optional)");
      if (q.answer) status("Not saved yet: tap Save to change your answer.");
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
