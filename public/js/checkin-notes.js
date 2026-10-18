// The check-in's "Something not right?" section: save a note for the next
// plan update (one per exercise picked, kept together as a group), edit or
// take one back before it's used, and answer the follow-up on an ongoing
// one ("Still bothering you?"). Notes are written only by the
// functions in functions/src/feedback/feedbackNotes.ts; this page listens to
// them. On a group plan, the member's own layer works around them.
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { db, functions } from "./firebase-init.js";
import { showToast } from "./ui-messages.js";
import { loadCurrentProgram } from "./current-program.js";
import { normalizeDay } from "./days.js";
import {
  MAX_PENDING_NOTES, MAX_ACTIVE_NOTES, FEEDBACK_TAGS, tagLabel, isQuestionOnly, PAIN_SAFETY, noteTitle, followUpChoices, followUpDone, errorText,
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
  bindForm();

  onSnapshot(
    query(collection(db, "users", uid, "feedbackNotes"), where("status", "in", ["pending", "open", "resolved"])),
    (snap) => {
      const notes = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt?.toMillis?.() ?? Infinity) - (b.createdAt?.toMillis?.() ?? Infinity));
      renderFollowUps(notes.filter((n) => n.status === "open" || (n.status === "resolved" && n.announced === false)));
      const pending = notes.filter((n) => n.status === "pending");
      // Check-in answers show on their own question, not in this list, and
      // have their own limit on the server.
      const ownPending = pending.filter((n) => n.source !== CHECKIN_ANSWER);
      pendingOwnCount = ownPending.length;
      activeOwnCount = notes.filter((n) => (n.status === "pending" || n.status === "open") && n.source !== CHECKIN_ANSWER).length;
      renderPending(ownPending);
      renderUpdateLine(notes);
      onPendingChange?.(pending.length);
    },
    (err) => console.error("[checkin] notes listener failed", err)
  );
}

/* ---------- the form ---------- */

let pendingOwnCount = 0;
let activeOwnCount = 0;

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

// Every exercise in the current week, grouped by day, so a note can name the
// slots it's about. The day is stored as the full weekday name the Program
// page matches on (or none, for an older plan's "Day 1").
async function fillExercises(uid, summary) {
  let program = null;
  try {
    program = await loadCurrentProgram(uid, summary);
  } catch (err) {
    console.error("[checkin] couldn't load the plan for the exercise list", err);
  }
  const seen = new Set();
  const groups = [];
  for (const s of program?.sessions || []) {
    const day = normalizeDay(s.day) ?? "";
    const chips = [];
    for (const ex of s.exercises || []) {
      const name = ex.name?.trim(); // as the server stores it
      const key = `${day}|${name}`;
      if (!name || seen.has(key) || /^rest(\s|$)/i.test(name)) continue;
      seen.add(key);
      chips.push(`<label><input type="checkbox" name="noteExercise" value="${esc(key)}"><span>${esc(name)}</span></label>`);
    }
    if (chips.length) groups.push(`<p class="fb-day">${esc(s.day || "Other")}</p><div class="chips">${chips.join("")}</div>`);
  }
  $("noteExercises").innerHTML = groups.join("") || `<p class="muted small" style="margin:0">No exercises in this week's plan.</p>`;
  $("noteExercises").addEventListener("change", syncExerciseHint);
  syncExerciseHint();
}

const pickedExercises = () => [...document.querySelectorAll('input[name="noteExercise"]:checked')]
  .map((el) => { const [day, exercise] = el.value.split(/\|(.*)/s); return { day: day || null, exercise }; });

// The collapsed row says what's picked, so the list can stay closed.
function syncExerciseHint() {
  const names = pickedExercises().map((p) => p.exercise);
  $("noteExercisesHint").textContent = !names.length ? "None picked: it's about your plan in general"
    : names.length === 1 ? names[0] : `${names.length} picked: ${names.join(", ")}`;
}

// The group being edited: its id and how many waiting notes it has.
let editing = null;

function bindForm() {
  $("noteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("noteSaveBtn");
    if (btn.disabled) return;
    const tags = checkedTags();
    const exercises = pickedExercises();
    const text = $("noteText").value.trim();
    if (!tags.length) return setNoteStatus("Pick what it's about first.");
    if (!text && (!exercises.length || isQuestionOnly(tags))) return setNoteStatus("Tell us a bit more, or pick the exercises it's about.");
    // The server's limits, checked up front too. An edit frees its own notes.
    const adding = Math.max(exercises.length, 1) - (editing?.size ?? 0);
    const room = Math.min(MAX_PENDING_NOTES - pendingOwnCount, MAX_ACTIVE_NOTES - activeOwnCount);
    if (adding > room) {
      return setNoteStatus(room <= 0
        ? `You can't add more notes right now. Update your plan, or mark some as better, first.`
        : `You can add ${room} more ${room === 1 ? "note" : "notes"} right now. Pick fewer exercises.`);
    }
    const duration = document.querySelector('input[name="noteDuration"]:checked')?.value ?? "week";

    btn.disabled = true;
    setNoteStatus("Saving…");
    const card = { tags, text, duration, exercises };
    try {
      if (editing) await httpsCallable(functions, "updateFeedbackNoteGroup")({ groupId: editing.id, ...card });
      else await httpsCallable(functions, "addFeedbackNote")(card);
      const n = Math.max(exercises.length, 1);
      setNoteStatus(editing ? "Changes saved. They go into your next plan update."
        : n === 1 ? "Saved. It goes into your next plan update." : `Saved ${n} notes. They go into your next plan update.`);
      resetForm();
    } catch (err) {
      setNoteStatus(errorText(err));
    } finally {
      btn.disabled = false;
    }
  });
  $("noteCancelEdit").addEventListener("click", () => { resetForm(); setNoteStatus(""); });
}

function resetForm() {
  editing = null;
  $("noteForm").reset();
  document.querySelectorAll("#noteExercises [data-extra]").forEach((el) => el.remove());
  $("noteSaveBtn").textContent = "Save note";
  $("noteCancelEdit").hidden = true;
  syncFormToTags();
  syncExerciseHint();
}

// Fills the form from a group's notes, which share tags, text and duration.
function editGroup(groupId) {
  const notes = pendingGroups.get(groupId);
  if (!notes?.length) return;
  resetForm();
  editing = { id: groupId, size: notes.length };
  const [first] = notes;
  document.querySelectorAll('input[name="noteTag"]').forEach((el) => { el.checked = (first.tags || []).includes(el.value); });
  $("noteText").value = first.text || "";
  const duration = document.querySelector(`input[name="noteDuration"][value="${first.duration === "ongoing" ? "ongoing" : "week"}"]`);
  if (duration) duration.checked = true;
  for (const n of notes) if (n.exercise) exerciseBox(n.day, n.exercise).checked = true;
  $("noteExercisesBox").open = notes.some((n) => n.exercise);
  $("noteSaveBtn").textContent = "Save changes";
  $("noteCancelEdit").hidden = false;
  syncFormToTags();
  syncExerciseHint();
  setNoteStatus("");
  $("noteForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

// A note's exercise as a box on the list, added while editing if the plan no
// longer has it.
function exerciseBox(day, exercise) {
  const key = `${day ?? ""}|${exercise}`;
  const found = [...document.querySelectorAll('input[name="noteExercise"]')].find((el) => el.value === key);
  if (found) return found;
  $("noteExercises").insertAdjacentHTML("beforeend",
    `<div class="chips" data-extra><label><input type="checkbox" name="noteExercise" value="${esc(key)}"><span>${esc(day ? `${exercise} · ${day}` : exercise)}</span></label></div>`);
  return $("noteExercises").lastElementChild.querySelector("input");
}

const setNoteStatus = (msg) => { $("noteStatus").textContent = msg; };

/* ---------- waiting notes ---------- */

// Waiting notes by group, oldest first; a note saved before groups is its own.
let pendingGroups = new Map();

// A card's title: its exercises (and their day, when they share one), or the
// single note's own title.
function groupTitle(notes) {
  if (notes.length === 1) return noteTitle(notes[0]);
  const days = [...new Set(notes.map((n) => n.day))];
  const names = notes.map((n) => n.exercise).filter(Boolean).join(", ");
  return days.length === 1 && days[0] ? `${names} · ${days[0]}` : names;
}

function renderPending(notes) {
  pendingGroups = new Map();
  for (const n of notes) {
    const key = n.groupId || `note:${n.id}`;
    pendingGroups.set(key, [...(pendingGroups.get(key) || []), n]);
  }
  if (editing && !pendingGroups.has(editing.id)) { resetForm(); setNoteStatus("That note was used or removed, so it can't be edited."); }
  else if (editing) editing.size = pendingGroups.get(editing.id).length;

  const el = $("pendingNotes");
  if (!notes.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<p class="fb-list-head">Waiting for your next update</p>` + [...pendingGroups].map(([key, group]) => {
    const [n] = group;
    const title = groupTitle(group);
    const grouped = !key.startsWith("note:");
    const showText = n.text && group.some((g) => g.exercise);
    return `<div class="fb-card"><div class="fb-row">
      <div>
        <div class="fb-title">${esc(title)}</div>
        <div class="fb-meta">${esc((n.tags || []).map(tagLabel).join(", "))}${isQuestionOnly(n.tags || []) ? "" : n.duration === "ongoing" ? " · until it's better" : " · this week"}</div>
        ${showText ? `<p class="fb-text">${esc(n.text)}</p>` : ""}
      </div>
      <div class="fb-actions">
        ${grouped ? `<button class="link-btn" type="button" data-edit="${esc(key)}" aria-label="Edit note: ${esc(title)}">Edit</button>` : ""}
        <button class="link-btn" type="button" ${grouped ? `data-remove-group="${esc(key)}"` : `data-remove="${esc(n.id)}"`} aria-label="Remove note: ${esc(title)}">Remove</button>
      </div>
    </div></div>`;
  }).join("");
  el.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => editGroup(btn.dataset.edit)));
  el.querySelectorAll("[data-remove], [data-remove-group]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    const args = btn.dataset.removeGroup ? { groupId: btn.dataset.removeGroup } : { noteId: btn.dataset.remove };
    try {
      await httpsCallable(functions, "removeFeedbackNote")(args);
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
