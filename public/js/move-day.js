// The Program page's "Move day": swaps the selected day of the week with
// another, in a bottom sheet, through functions/src/feedback/moveDay.ts
// (no model call). On a group plan only the leader gets it, and it moves the
// day for the whole group. The page re-reads the plan afterwards (`onMoved`).
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";
import { normalizeDay } from "./days.js";
import { errorText } from "./plan-feedback.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** True when every day of `days` (the week strip's entries) names a weekday, so the week can be moved. */
export const canMoveWeek = (days) => days.length > 1 && days.every((d) => normalizeDay(d.day));

let sheet = null;

function sheetElement() {
  if (sheet) return sheet;
  sheet = document.createElement("dialog");
  sheet.className = "sheet";
  sheet.setAttribute("aria-labelledby", "moveDayTitle");
  document.body.appendChild(sheet);
  // A tap on the backdrop (outside the sheet's box) closes it.
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  return sheet;
}

/**
 * Opens the sheet for moving `day` (an entry of `days`, the week strip's
 * { day, focus } entries). `onMoved(toWeekday)` runs once the move is saved.
 */
export function openMoveDaySheet({ programId, days, day, isGroup, report, onMoved }) {
  const from = normalizeDay(day.day);
  const others = days.filter((d) => normalizeDay(d.day) !== from);
  const el = sheetElement();
  el.innerHTML = `
    <div class="sheet-head">
      <h3 id="moveDayTitle">Move ${esc(from)}</h3>
      <button class="sheet-close" type="button" aria-label="Close">✕</button>
    </div>
    <p class="muted small" style="margin:0 0 12px">${esc(day.focus)} swaps places with the day you pick${
      isGroup ? ". This moves it for everyone in your group." : "."}</p>
    <div role="radiogroup" aria-labelledby="moveDayTitle">
      ${others.map((d) => `<label class="swap-option">
        <input type="radio" name="moveDayTo" value="${esc(normalizeDay(d.day))}">
        <span><b>${esc(normalizeDay(d.day))}</b><span class="muted small">${esc(d.focus)}</span></span>
      </label>`).join("")}
    </div>
    <button class="btn full" id="moveDayApply" type="button" disabled>Swap days</button>
    <p class="status-line" id="moveDayStatus" role="status"></p>`;

  const $ = (sel) => el.querySelector(sel);
  const to = () => el.querySelector('input[name="moveDayTo"]:checked')?.value;
  const label = () => `Swap ${from} and ${to()}`;

  $(".sheet-close").addEventListener("click", () => el.close());
  el.querySelectorAll('input[name="moveDayTo"]').forEach((input) => input.addEventListener("change", () => {
    $("#moveDayApply").disabled = false;
    $("#moveDayApply").textContent = label();
  }));

  $("#moveDayApply").addEventListener("click", async () => {
    const target = to();
    if (!target) return;
    const btn = $("#moveDayApply");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Moving…`;
    $("#moveDayStatus").textContent = "";
    try {
      await httpsCallable(functions, "moveProgramDay")({ programId, from, to: target });
      el.close();
      report(`Swapped ${from} and ${target}.`);
      await onMoved(target);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label();
      $("#moveDayStatus").textContent = errorText(err);
    }
  });

  el.showModal();
}
