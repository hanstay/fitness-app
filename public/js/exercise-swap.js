// The Program page's "Not right?" on an exercise: swap it for an
// AI-suggested alternative (a bottom sheet), undo a swap, or leave a note for
// the next check-in. Swaps are made and undone by the functions in
// functions/src/feedback/exerciseSwap.ts, which edit the current program doc;
// the page re-reads it afterwards (`onChanged`).
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";
import { SWAP_REASONS, SWAP_SCOPES, PAIN_SAFETY, errorText } from "./plan-feedback.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The swap that put the exercise at sessions[si].exercises[ei] there, if any. */
export function swapAt(program, si, ei) {
  const ex = program.sessions?.[si]?.exercises?.[ei];
  if (!ex) return null;
  return (program.swaps || []).find((s) => s.sessionIndex === si && s.exerciseIndex === ei && s.to?.name === ex.name) ?? null;
}

/** The card's extra lines: the swapped-from pill (with Undo) and the "Not right?" button and its menu. */
export function exerciseActionsHtml(program, si, ei, day) {
  const ex = program.sessions[si].exercises[ei];
  const swap = swapAt(program, si, ei);
  const note = `checkin.html?${new URLSearchParams({ exercise: ex.name, day })}#feedback`;
  return `
    ${swap ? `<div class="sub swapped"><span class="pill">Swapped from ${esc(swap.from.name)}${swap.scope === "this_week" ? " this week" : ""}
      <button class="undo" type="button" data-undo="${esc(swap.id)}">Undo</button></span></div>` : ""}
    <div class="ex-actions">
      <button class="link-btn" type="button" data-more aria-expanded="false">Not right? ▾</button>
      <div class="ex-menu" hidden>
        <button class="btn secondary" type="button" data-swap="${si}:${ei}">Swap it</button>
        <a class="btn secondary" href="${esc(note)}">Note for check-in</a>
      </div>
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

/* ---------- the swap sheet ---------- */

let sheet = null;

function sheetElement() {
  if (sheet) return sheet;
  sheet = document.createElement("dialog");
  sheet.className = "sheet";
  sheet.setAttribute("aria-labelledby", "swapTitle");
  document.body.appendChild(sheet);
  // A tap on the backdrop (outside the sheet's box) closes it.
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  return sheet;
}

function openSwapSheet({ programId, program, sessionIndex, exerciseIndex, report, onChanged }) {
  const session = program.sessions[sessionIndex];
  const ex = session.exercises[exerciseIndex];
  const el = sheetElement();
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
