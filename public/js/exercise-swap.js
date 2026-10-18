// The Program page's "Not right?" on an exercise: swap it for an
// AI-suggested alternative, undo a swap, or leave a note for the next plan
// update, each in a bottom sheet on the page. A group member only gets the
// note: the group's exercises are shared, so their own update works around it
// instead. Swaps are made and undone by the functions in
// functions/src/feedback/exerciseSwap.ts, which edit the current program doc;
// the page re-reads it afterwards (`onChanged`). Notes are saved by
// functions/src/feedback/feedbackNotes.ts, the same as the check-in's.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";
import { normalizeDay } from "./days.js";
import { SWAP_REASONS, SWAP_SCOPES, FEEDBACK_TAGS, PAIN_SAFETY, isQuestionOnly, errorText } from "./plan-feedback.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The swap that put the exercise at sessions[si].exercises[ei] there, if any. */
export function swapAt(program, si, ei) {
  const ex = program.sessions?.[si]?.exercises?.[ei];
  if (!ex) return null;
  return (program.swaps || []).find((s) => s.sessionIndex === si && s.exerciseIndex === ei && s.to?.name === ex.name) ?? null;
}

/**
 * Notes waiting for the next update are matched to a card by its day and
 * exercise. A note's day is stored as the full weekday name (or null), and
 * older plans can say "Mon" or "Day 1", so both sides are normalized.
 */
export const noteKey = (day, exercise) => `${normalizeDay(day) ?? ""}|${exercise}`;

/**
 * The card's extra lines: the swapped-from pill (with Undo), the waiting
 * note's pill (with Remove), and the "Not right?" button and its menu.
 * canSwap: false leaves only the note, so "Not right?" opens it straight away.
 * note: a waiting note on this exercise.
 */
export function exerciseActionsHtml(program, si, ei, day, { canSwap = true, note = null } = {}) {
  const swap = canSwap ? swapAt(program, si, ei) : null;
  return `
    ${swap ? `<div class="sub swapped"><span class="pill">Swapped from ${esc(swap.from.name)}${swap.scope === "this_week" ? " this week" : ""}
      <button class="undo" type="button" data-undo="${esc(swap.id)}">Undo</button></span></div>` : ""}
    ${note ? `<div class="sub swapped"><span class="pill">Note for your next update
      <button class="undo" type="button" data-remove-note="${esc(note.id)}">Remove</button></span></div>` : ""}
    <div class="ex-actions">${canSwap ? `
      <button class="link-btn" type="button" data-more aria-expanded="false">Not right? ▾</button>
      <div class="ex-menu" hidden>
        <button class="btn secondary" type="button" data-swap="${si}:${ei}">Swap it</button>
        <button class="btn secondary" type="button" data-note="${si}:${ei}">Leave a note</button>
      </div>` : `
      <button class="link-btn" type="button" data-note="${si}:${ei}">Not right?</button>`}
    </div>`;
}

/**
 * Wires the buttons exerciseActionsHtml drew inside `container`.
 * `report(message, isError)` shows the outcome; `onChanged()` reloads the plan.
 */
export function bindExerciseActions(container, { programId, program, report, onChanged }) {
  container.querySelectorAll("[data-more]").forEach((btn) => btn.addEventListener("click", () => {
    const menu = btn.nextElementSibling;
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
  }));
  container.querySelectorAll("[data-swap]").forEach((btn) => btn.addEventListener("click", () => {
    const [si, ei] = btn.dataset.swap.split(":").map(Number);
    openSwapSheet({ programId, program, sessionIndex: si, exerciseIndex: ei, report, onChanged });
  }));
  container.querySelectorAll("[data-note]").forEach((btn) => btn.addEventListener("click", () => {
    const [si, ei] = btn.dataset.note.split(":").map(Number);
    openNoteSheet({ program, sessionIndex: si, exerciseIndex: ei, report });
  }));
  container.querySelectorAll("[data-remove-note]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await httpsCallable(functions, "removeFeedbackNote")({ noteId: btn.dataset.removeNote });
      report("Note removed.");
    } catch (err) {
      btn.disabled = false;
      report(errorText(err), true);
    }
  }));
  container.querySelectorAll("[data-undo]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await httpsCallable(functions, "undoExerciseSwap")({ programId, swapId: btn.dataset.undo });
      report("Swap undone.");
      await onChanged();
    } catch (err) {
      btn.disabled = false;
      report(errorText(err), true);
    }
  }));
}

/* ---------- the sheets ---------- */

let sheet = null;

function sheetElement() {
  if (sheet) return sheet;
  sheet = document.createElement("dialog");
  sheet.className = "sheet";
  document.body.appendChild(sheet);
  // A tap on the backdrop (outside the sheet's box) closes it.
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  return sheet;
}

function openSwapSheet({ programId, program, sessionIndex, exerciseIndex, report, onChanged }) {
  const session = program.sessions[sessionIndex];
  const ex = session.exercises[exerciseIndex];
  const el = sheetElement();
  el.setAttribute("aria-labelledby", "swapTitle");
  el.innerHTML = `
    <div class="sheet-head">
      <h3 id="swapTitle">Swap ${esc(ex.name)}</h3>
      <button class="sheet-close" type="button" aria-label="Close">✕</button>
    </div>
    <p class="muted small" style="margin:0 0 12px">${esc(session.day)} · ${ex.sets} × ${esc(ex.reps)}</p>
    <div class="field">
      <label id="swapReasonLabel">Why swap it?</label>
      <div class="chips" role="radiogroup" aria-labelledby="swapReasonLabel">
        ${SWAP_REASONS.map(([value, label]) => `<label><input type="radio" name="swapReason" value="${value}"><span>${esc(label)}</span></label>`).join("")}
      </div>
    </div>
    <div class="callout warn small" id="swapPain" hidden>${esc(PAIN_SAFETY)} We'll also save a note, so your next update works around it.</div>
    <button class="btn secondary full" id="swapFind" type="button" disabled>Show alternatives</button>
    <div id="swapOptions" style="margin-top:12px"></div>
    <div class="field" id="swapScopeField" hidden>
      <label id="swapScopeLabel">For how long?</label>
      <div class="seg" role="radiogroup" aria-labelledby="swapScopeLabel">
        ${SWAP_SCOPES.map(([value, label], i) => `<label><input type="radio" name="swapScope" value="${value}"${i === 0 ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}
      </div>
    </div>
    <button class="btn full" id="swapApply" type="button" hidden disabled>Swap exercise</button>
    <p class="status-line" id="swapStatus" role="status"></p>`;

  const $ = (sel) => el.querySelector(sel);
  const setStatus = (msg) => { $("#swapStatus").textContent = msg; };
  const reason = () => el.querySelector('input[name="swapReason"]:checked')?.value;
  let options = [];

  $(".sheet-close").addEventListener("click", () => el.close());
  el.querySelectorAll('input[name="swapReason"]').forEach((input) => input.addEventListener("change", () => {
    $("#swapPain").hidden = reason() !== "hurts";
    $("#swapFind").disabled = false;
    // Alternatives were for the previous reason.
    options = [];
    $("#swapOptions").innerHTML = "";
    $("#swapScopeField").hidden = true;
    $("#swapApply").hidden = true;
  }));

  $("#swapFind").addEventListener("click", async () => {
    const btn = $("#swapFind");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Finding alternatives…`;
    setStatus("");
    try {
      const result = await httpsCallable(functions, "suggestExerciseSwaps")({ programId, sessionIndex, exerciseIndex, reason: reason() });
      options = result.data.options;
      renderOptions();
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      btn.disabled = false;
      btn.textContent = options.length ? "Show different alternatives" : "Show alternatives";
    }
  });

  function renderOptions() {
    $("#swapOptions").innerHTML = options.map((o, i) => {
      const detail = [`${o.sets} × ${esc(o.reps)}`, o.rest_seconds > 0 ? `rest ${o.rest_seconds}s` : null, o.load_note ? esc(o.load_note) : null]
        .filter(Boolean).join(" · ");
      return `<label class="swap-option">
        <input type="radio" name="swapOption" value="${i}">
        <span><b>${esc(o.name)}</b><span class="small">${detail}</span><span class="muted small">${esc(o.why)}</span></span>
      </label>`;
    }).join("");
    $("#swapScopeField").hidden = false;
    $("#swapApply").hidden = false;
    $("#swapApply").disabled = true;
    el.querySelectorAll('input[name="swapOption"]').forEach((input) =>
      input.addEventListener("change", () => { $("#swapApply").disabled = false; }));
  }

  $("#swapApply").addEventListener("click", async () => {
    const picked = options[Number(el.querySelector('input[name="swapOption"]:checked')?.value)];
    if (!picked) return;
    const btn = $("#swapApply");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Swapping…`;
    try {
      await httpsCallable(functions, "applyExerciseSwap")({
        programId, sessionIndex, exerciseIndex, expectedName: ex.name, option: picked, reason: reason(),
        scope: el.querySelector('input[name="swapScope"]:checked')?.value ?? "this_week",
      });
      el.close();
      report(`Swapped ${ex.name} for ${picked.name}.`);
      await onChanged();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Swap exercise";
      setStatus(errorText(err));
    }
  });

  el.showModal();
}

/* ---------- the note sheet ---------- */

function openNoteSheet({ program, sessionIndex, exerciseIndex, report }) {
  const session = program.sessions[sessionIndex];
  const ex = session.exercises[exerciseIndex];
  const el = sheetElement();
  el.setAttribute("aria-labelledby", "noteSheetTitle");
  el.innerHTML = `
    <div class="sheet-head">
      <h3 id="noteSheetTitle">Note on ${esc(ex.name)}</h3>
      <button class="sheet-close" type="button" aria-label="Close">✕</button>
    </div>
    <p class="muted small" style="margin:0 0 12px">${esc(session.day)} · your next plan update works around it, and says what it changed.</p>
    <div class="field">
      <label id="noteSheetTagsLabel">What's it about?</label>
      <div class="chips" role="group" aria-labelledby="noteSheetTagsLabel">
        ${FEEDBACK_TAGS.map(([tag, label]) => `<label><input type="checkbox" name="noteSheetTag" value="${tag}"><span>${esc(label)}</span></label>`).join("")}
      </div>
    </div>
    <div class="callout warn small" id="noteSheetPain" hidden>${esc(PAIN_SAFETY)}</div>
    <div class="field">
      <label for="noteSheetText">Tell us more <span class="muted">(optional)</span></label>
      <textarea class="input" id="noteSheetText" maxlength="1000" rows="3"></textarea>
    </div>
    <div class="field" id="noteSheetDuration">
      <label id="noteSheetDurationLabel">How long should your plan work around it?</label>
      <div class="seg" role="radiogroup" aria-labelledby="noteSheetDurationLabel">
        <label><input type="radio" name="noteSheetDuration" value="week" checked><span>Just this week</span></label>
        <label><input type="radio" name="noteSheetDuration" value="ongoing"><span>Until I say it's better</span></label>
      </div>
    </div>
    <button class="btn full" id="noteSheetSave" type="button">Save note</button>
    <p class="status-line" id="noteSheetStatus" role="status"></p>`;

  const $ = (sel) => el.querySelector(sel);
  const setStatus = (msg) => { $("#noteSheetStatus").textContent = msg; };
  const tags = () => [...el.querySelectorAll('input[name="noteSheetTag"]:checked')].map((i) => i.value);

  $(".sheet-close").addEventListener("click", () => el.close());
  // The safety line shows for pain; a question has nothing to work around.
  el.querySelectorAll('input[name="noteSheetTag"]').forEach((input) => input.addEventListener("change", () => {
    $("#noteSheetPain").hidden = !tags().includes("pain");
    $("#noteSheetDuration").hidden = isQuestionOnly(tags());
  }));

  $("#noteSheetSave").addEventListener("click", async () => {
    const picked = tags();
    const text = $("#noteSheetText").value.trim();
    if (!picked.length) return setStatus("Pick what it's about first.");
    if (!text && isQuestionOnly(picked)) return setStatus("Write your question first.");
    const btn = $("#noteSheetSave");
    btn.disabled = true;
    setStatus("Saving…");
    try {
      await httpsCallable(functions, "addFeedbackNote")({
        tags: picked, text, exercise: ex.name, day: normalizeDay(session.day),
        duration: el.querySelector('input[name="noteSheetDuration"]:checked')?.value ?? "week",
      });
      el.close();
      report("Saved. It goes into your next plan update.");
    } catch (err) {
      btn.disabled = false;
      setStatus(errorText(err));
    }
  });

  el.showModal();
}
