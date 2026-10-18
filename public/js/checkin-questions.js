// The check-in's questions about the data (built by
// functions/src/lib/checkinQuestions.ts and served by getCheckinQuestions):
// "Welcome back" after a long gap, and a nudge when Hevy has nothing new.
// A tap saves the answer straight away as a note for the next plan update;
// "Change" reopens an answer, and tapping the chosen one again takes it back.
// Why the week went the way it did is for the athlete's own note below.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";
import { errorText } from "./plan-feedback.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (id) => document.getElementById(id);

/** The athlete's own date and time zone, so the dates are theirs. */
const clock = () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { today, tzOffset: d.getTimezoneOffset() };
};

let questions = []; // as last loaded
let onImport = () => {};
let loading = null;
let started = false; // initCheckinQuestions has run
const expanded = new Set(); // answered questions opened again with "Change"

// A dismissed card stays hidden for the day on this device (sessionStorage
// can throw in private mode; then it just comes back on reload).
const DISMISS_KEY = () => `checkinDismissed:${clock().today}`;
const dismissed = new Set((() => { try { return JSON.parse(sessionStorage.getItem(DISMISS_KEY()) || "[]"); } catch { return []; } })());
const saveDismissed = () => { try { sessionStorage.setItem(DISMISS_KEY(), JSON.stringify([...dismissed])); } catch { /* see above */ } };

/** Load the questions (the section shows once there are some). onImportNow opens the Hevy import. */
export function initCheckinQuestions({ onImportNow } = {}) {
  onImport = onImportNow ?? onImport;
  started = true;
  refreshCheckinQuestions();
}

/** Reload after new data comes in (a Hevy import). */
export async function refreshCheckinQuestions() {
  if (!started) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const { data } = await httpsCallable(functions, "getCheckinQuestions")(clock());
      questions = data.questions;
      render();
    } catch (err) {
      console.error("[checkin] questions failed to load", err);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/* ---------- rendering ---------- */

function render() {
  const shown = questions.filter((q) => !dismissed.has(q.key));
  $("weekSection").style.display = shown.length ? "" : "none";
  $("weekCards").innerHTML = shown.map((q) => (q.answer && !expanded.has(q.key) ? doneRow(q) : card(q))).join("");
  document.querySelectorAll("#weekCards .cq-card").forEach(bindCard);
  document.querySelectorAll("#weekCards [data-change]").forEach((b) => b.addEventListener("click", () => {
    expanded.add(b.dataset.change);
    render();
  }));
}

const answerLabel = (q) => q.answers.find((x) => x.id === q.answer.answerId)?.label ?? "";

function doneRow(q) {
  return `<div class="cq-done"><span class="tick" aria-hidden="true">✓</span>
    <span class="what">${esc(q.text)} <b>${esc(answerLabel(q))}</b></span>
    <button class="link-btn" type="button" data-change="${esc(q.key)}">Change</button></div>`;
}

const cardId = (q, s) => `cq-${q.key.replace(/[^a-zA-Z0-9]/g, "_")}-${s}`;

function card(q) {
  const chosen = q.answer?.answerId;
  return `<div class="cq-card ${q.kind === "long_gap" ? "cq-welcome" : "cq-warn"}" data-key="${esc(q.key)}">
    <div class="cq-src">${esc(q.source)}</div>
    <p class="cq-text" id="${cardId(q, "q")}">${esc(q.text)}</p>
    <div class="chips" role="radiogroup" aria-labelledby="${cardId(q, "q")}">
      ${q.answers.map((a) => `<label><input type="radio" name="${esc(cardId(q, "a"))}" value="${esc(a.id)}"${a.id === chosen ? " checked" : ""}><span>${esc(a.label)}</span></label>`).join("")}
    </div>
    <div class="cq-follow"></div>
    <p class="status-line small" role="status"></p>
    ${q.answer ? `<button class="link-btn cq-skip" type="button" data-collapse>Done</button>` : ""}
  </div>`;
}

function detailsHtml(q) {
  const id = cardId(q, "text");
  return `<div class="field" style="margin:0"><label for="${id}">Anything to add? (optional)</label>
      <textarea class="input" id="${id}" maxlength="1000" rows="2"></textarea></div>
    <button class="btn secondary" type="button" data-save>Save</button>`;
}

/* ---------- answering ---------- */

function bindCard(el) {
  const q = questions.find((x) => x.key === el.dataset.key);
  if (!q) return;
  const status = (msg) => { el.querySelector(".status-line").textContent = msg; };
  const follow = el.querySelector(".cq-follow");

  const save = async (answerId, extra = {}) => {
    el.querySelectorAll("input, button, textarea").forEach((c) => { c.disabled = true; });
    status("Saving…");
    try {
      const { data } = await httpsCallable(functions, "answerCheckinQuestion")({ key: q.key, answerId, ...clock(), ...extra });
      // A reload while this saved has replaced the question objects.
      const saved = questions.find((x) => x.key === q.key) ?? q;
      saved.answer = { noteId: data.noteId, answerId };
      expanded.delete(q.key);
      render();
    } catch (err) {
      status(errorText(err));
      el.querySelectorAll("input, button, textarea").forEach((c) => { c.disabled = false; });
    }
  };

  el.querySelector("[data-collapse]")?.addEventListener("click", () => {
    expanded.delete(q.key);
    render();
  });

  el.querySelectorAll(":scope > .chips input").forEach((input) => {
    // Tapping the chosen answer again takes it back.
    input.addEventListener("click", async () => {
      if (q.answer?.answerId !== input.value) return;
      input.checked = false;
      follow.innerHTML = "";
      status("Removing…");
      try {
        await httpsCallable(functions, "removeFeedbackNote")({ noteId: q.answer.noteId });
        q.answer = null;
        expanded.add(q.key); // stays open, unanswered
        render();
      } catch (err) {
        input.checked = true;
        status(errorText(err));
      }
    });
    input.addEventListener("change", () => answer(input.value));
  });

  function answer(answerId) {
    const a = q.answers.find((x) => x.id === answerId);
    if (!a) return;
    status("");
    follow.innerHTML = "";
    if (a.action === "import") { onImport(); return; }
    if (a.action === "dismiss") {
      dismissed.add(q.key);
      saveDismissed();
      render();
      return;
    }
    if (a.details) {
      follow.innerHTML = detailsHtml(q);
      if (q.answer) status("Not saved yet: tap Save to change your answer.");
      follow.querySelector("[data-save]").addEventListener("click", () => save(answerId, { text: follow.querySelector("textarea").value.trim() }));
      return;
    }
    save(answerId);
  }
}
