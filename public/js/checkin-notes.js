// The check-in's "Something not right?" section: save a note for the next
// plan update, take one back before it's used, and answer the follow-up on
// an ongoing one ("Still bothering you?"). Notes are written only by the
// functions in functions/src/feedback/feedbackNotes.ts; this page listens to
// them. On a group plan, the member's own layer works around them.
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { db, functions } from "./firebase-init.js";
import { showToast } from "./ui-messages.js";
import { loadCurrentProgram } from "./current-program.js";
import {
  FEEDBACK_TAGS, tagLabel, isQuestionOnly, PAIN_SAFETY, noteTitle, followUpChoices, followUpDone, errorText,
} from "./plan-feedback.js";

const CHECKIN_ANSWER = "checkin_question"; // a note saved by answering a check-in question (checkin-questions.js)
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (id) => document.getElementById(id);

/**
 * onPendingChange(count) hears how many notes and check-in answers are
 * waiting for the next update, which counts as something new for it.
 */
export async function initCheckinNotes(uid, summary, { onPendingChange } = {}) {
  const section = $("feedbackSection");
  section.style.display = "";

  renderTagChips();
  await fillExercises(uid, summary);
  prefillFromLink();
  bindForm();

  onSnapshot(
    query(collection(db, "users", uid, "feedbackNotes"), where("status", "in", ["pending", "open", "resolved"])),
    (snap) => {
      const notes = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt?.toMillis?.() ?? Infinity) - (b.createdAt?.toMillis?.() ?? Infinity));
      renderFollowUps(notes.filter((n) => n.status === "open" || (n.status === "resolved" && n.announced === false)));
      const pending = notes.filter((n) => n.status === "pending");
      // Check-in answers show on their own question, not in this list.
      renderPending(pending.filter((n) => n.source !== CHECKIN_ANSWER));
      renderUpdateLine(notes);
      onPendingChange?.(pending.length);
    },
    (err) => console.error("[checkin] notes listener failed", err)
  );
}

/* ---------- the form ---------- */

function renderTagChips() {
  $("noteTags").innerHTML = FEEDBACK_TAGS.map(([tag, label]) =>
    `<label><input type="checkbox" name="noteTag" value="${tag}"><span>${esc(label)}</span></label>`).join("");
  $("painCallout").textContent = PAIN_SAFETY;
  $("noteTags").addEventListener("change", syncFormToTags);
}

const checkedTags = () => [...document.querySelectorAll('input[name="noteTag"]:checked')].map((el) => el.value);

// The safety line shows for pain; a question has nothing to work around.
function syncFormToTags() {
  const tags = checkedTags();
  $("painCallout").style.display = tags.includes("pain") ? "block" : "none";
  $("noteDurationField").style.display = isQuestionOnly(tags) ? "none" : "";
}

// Every exercise in the current week, by day, so a note can name its slot.
async function fillExercises(uid, summary) {
  let program = null;
  try {
    program = await loadCurrentProgram(uid, summary);
  } catch (err) {
    console.error("[checkin] couldn't load the plan for the exercise list", err);
  }
  const seen = new Set();
  const options = [];
  for (const s of program?.sessions || []) {
    for (const ex of s.exercises || []) {
      const key = `${s.day}|${ex.name}`;
      if (seen.has(key) || /^rest(\s|$)/i.test(ex.name || "")) continue;
      seen.add(key);
      options.push(`<option value="${esc(key)}">${esc(s.day)} · ${esc(ex.name)}</option>`);
    }
  }
  $("noteExercise").insertAdjacentHTML("beforeend", options.join(""));
}

// The Program page's "Note for check-in" links here as
// checkin.html?exercise=…&day=…#feedback.
function prefillFromLink() {
  const params = new URLSearchParams(location.search);
  const exercise = params.get("exercise");
  if (!exercise) return;
  const key = `${params.get("day") ?? ""}|${exercise}`;
  const select = $("noteExercise");
  if (![...select.options].some((o) => o.value === key)) {
    select.insertAdjacentHTML("beforeend", `<option value="${esc(key)}">${esc(params.get("day") ?? "")} · ${esc(exercise)}</option>`);
  }
  select.value = key;
  if (location.hash === "#feedback") $("feedbackSection").scrollIntoView();
}

function bindForm() {
  $("noteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("noteSaveBtn");
    if (btn.disabled) return;
    const tags = checkedTags();
    const [day, exercise] = $("noteExercise").value ? $("noteExercise").value.split(/\|(.*)/s) : [null, null];
    const text = $("noteText").value.trim();
    if (!tags.length) return setNoteStatus("Pick what it's about first.");
    if (!text && (!exercise || isQuestionOnly(tags))) return setNoteStatus("Tell us a bit more, or pick the exercise it's about.");
    const duration = document.querySelector('input[name="noteDuration"]:checked')?.value ?? "week";

    btn.disabled = true;
    setNoteStatus("Saving…");
    try {
      await httpsCallable(functions, "addFeedbackNote")({ tags, text, exercise: exercise || null, day: day || null, duration });
      $("noteForm").reset();
      syncFormToTags();
      setNoteStatus("Saved. It goes into your next plan update.");
    } catch (err) {
      setNoteStatus(errorText(err));
    } finally {
      btn.disabled = false;
    }
  });
}

const setNoteStatus = (msg) => { $("noteStatus").textContent = msg; };

/* ---------- waiting notes ---------- */

function renderPending(notes) {
  const el = $("pendingNotes");
  if (!notes.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<p class="fb-list-head">Waiting for your next update</p>` + notes.map((n) => `
    <div class="fb-card"><div class="fb-row">
      <div>
        <div class="fb-title">${esc(noteTitle(n))}</div>
        <div class="fb-meta">${esc((n.tags || []).map(tagLabel).join(", "))}${isQuestionOnly(n.tags || []) ? "" : n.duration === "ongoing" ? " · until it's better" : " · this week"}</div>
        ${n.text && n.exercise ? `<p class="fb-text">${esc(n.text)}</p>` : ""}
      </div>
      <button class="link-btn" type="button" data-remove="${esc(n.id)}" aria-label="Remove note: ${esc(noteTitle(n))}">Remove</button>
    </div></div>`).join("");
  el.querySelectorAll("[data-remove]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await httpsCallable(functions, "removeFeedbackNote")({ noteId: btn.dataset.remove });
    } catch (err) {
      btn.disabled = false;
      setNoteStatus(errorText(err));
    }
  }));
}

/* ---------- "Still bothering you?" ---------- */

// A note answered since the update last used it shows the answer instead of
// asking again; the next update will act on it.
const answered = (n) => n.status === "resolved" ||
  (n.lastFollowUp && (n.followedUpAt?.toMillis?.() ?? 0) > (n.handledAt?.toMillis?.() ?? 0));

let followUpNotes = new Map();

function renderFollowUps(notes) {
  const el = $("followUps");
  if (!notes.length) { el.innerHTML = ""; return; }
  // One collapsed line, so a few long-running notes don't crowd the page;
  // answered ones drop out of the list until the next update asks again.
  const toCheck = notes.filter((n) => !answered(n));
  followUpNotes = new Map(notes.map((n) => [n.id, n]));
  const wasOpen = el.querySelector("details")?.open ?? false;
  const things = notes.length === 1 ? "1 thing" : `${notes.length} things`;
  const summary = toCheck.length
    ? `${toCheck.length === 1 ? "1 to check" : `${toCheck.length} to check`}`
    : "all checked for this week";
  el.innerHTML = `<details class="disclosure fb-followups"${wasOpen ? " open" : ""}>
    <summary><span><span class="disclosure-title">Your plan is working around ${things}</span>
      <span class="disclosure-hint">${esc(summary)}</span></span></summary>
    <div class="disclosure-body">${toCheck.map((n) => {
      const pain = (n.tags || []).includes("pain");
      return `<div class="fb-row fb-compact">
        <div>
          <div class="fb-title">${esc(noteTitle(n))}</div>
          <div class="fb-meta">${esc((n.tags || []).map(tagLabel).join(", "))}</div>
        </div>
        <div class="fb-answers">${followUpChoices(n).map(([outcome, label]) =>
          `<button class="btn secondary" type="button" data-note="${esc(n.id)}" data-outcome="${outcome}">${esc(label)}</button>`).join("")}
          ${pain ? `<button class="link-btn" type="button" data-note="${esc(n.id)}" data-outcome="worse">Worse?</button>` : ""}</div>
      </div>`;
    }).join("") || `<p class="muted small" style="margin:0">Thanks. Your next update will use your answers.</p>`}</div>
  </details>`;
  el.querySelectorAll("[data-outcome]").forEach((btn) => btn.addEventListener("click", async () => {
    const card = btn.closest(".fb-row");
    card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await httpsCallable(functions, "followUpFeedbackNote")({ noteId: btn.dataset.note, outcome: btn.dataset.outcome });
      const note = followUpNotes.get(btn.dataset.note);
      if (note) showToast(followUpDone(note, btn.dataset.outcome), { durationMs: 6000 });
    } catch (err) {
      card.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      setNoteStatus(errorText(err));
    }
  }));
}

/* ---------- the update button's line ---------- */

function renderUpdateLine(notes) {
  const inUse = notes.filter((n) => n.status === "pending" || n.status === "open" || (n.status === "resolved" && n.announced === false));
  const answers = inUse.filter((n) => n.source === CHECKIN_ANSWER).length;
  const own = inUse.length - answers;
  const parts = [
    answers ? (answers === 1 ? "1 answer" : `${answers} answers`) : null,
    own ? (own === 1 ? "1 note" : `${own} notes`) : null,
  ].filter(Boolean);
  const el = $("notesForUpdate");
  el.style.display = parts.length ? "" : "none";
  el.textContent = `Your ${parts.join(" and ")} ${inUse.length === 1 ? "goes" : "go"} into your next plan update.`;
}
