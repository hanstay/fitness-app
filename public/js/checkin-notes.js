// The check-in's "Something not right?" section: save a note for the next
// plan update, take one back before it's used, and answer the follow-up on
// an ongoing one ("Still bothering you?"). Notes are written only by the
// functions in functions/src/feedback/feedbackNotes.ts; this page listens to
// them. Personal plans only: a group plan is written for the whole group.
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { db, functions } from "./firebase-init.js";
import { loadCurrentProgram } from "./current-program.js";
import {
  FEEDBACK_TAGS, tagLabel, isQuestionOnly, PAIN_SAFETY, noteTitle, followUpChoices, followUpDone, errorText,
} from "./plan-feedback.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (id) => document.getElementById(id);

export async function initCheckinNotes(uid, summary) {
  if (summary?.activeProgramSource === "group" && summary?.groupId) return;
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
      renderPending(notes.filter((n) => n.status === "pending"));
      renderUpdateLine(notes);
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

function renderFollowUps(notes) {
  const el = $("followUps");
  if (!notes.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<p class="fb-list-head" style="margin-top:4px">Still bothering you?</p>` + notes.map((n) => {
    const pain = (n.tags || []).includes("pain");
    const lastResponse = n.response?.text ? `<p class="fb-text muted">Last update: ${esc(n.response.text)}</p>` : "";
    const body = answered(n)
      ? `<p class="fb-text">${esc(followUpDone(n, n.status === "resolved" ? "better" : n.lastFollowUp))}</p>`
      : `<div class="btn-row">${followUpChoices(n).map(([outcome, label]) =>
          `<button class="btn secondary" type="button" data-note="${esc(n.id)}" data-outcome="${outcome}">${esc(label)}</button>`).join("")}</div>
         ${pain ? `<button class="link-btn" type="button" data-note="${esc(n.id)}" data-outcome="worse">Worse than before?</button>` : ""}`;
    return `<div class="fb-card">
      <div class="fb-title">${esc(noteTitle(n))}</div>
      <div class="fb-meta">${esc((n.tags || []).map(tagLabel).join(", "))}</div>
      ${lastResponse}
      ${body}
    </div>`;
  }).join("");
  el.querySelectorAll("[data-outcome]").forEach((btn) => btn.addEventListener("click", async () => {
    const card = btn.closest(".fb-card");
    card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await httpsCallable(functions, "followUpFeedbackNote")({ noteId: btn.dataset.note, outcome: btn.dataset.outcome });
    } catch (err) {
      card.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      setNoteStatus(errorText(err));
    }
  }));
}

/* ---------- the update button's line ---------- */

function renderUpdateLine(notes) {
  const used = notes.filter((n) => n.status === "pending" || n.status === "open" || (n.status === "resolved" && n.announced === false)).length;
  const el = $("notesForUpdate");
  el.style.display = used ? "" : "none";
  el.textContent = used === 1 ? "Your note goes into this update." : `Your ${used} notes go into this update.`;
}
