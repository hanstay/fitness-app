// The Program page's "Rearrange week": a bottom sheet listing the seven days
// of the current week, where a session is dragged by its handle to another
// day and the days in between shift along. Fixed sessions (a class the
// athlete or group has committed to) are locked to their day. Nothing is
// saved until "Save new order", which sends the whole new order in one call
// to functions/src/feedback/moveDay.ts (no model call). On a group plan only
// the leader gets it, and it rearranges the week for the whole group.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";
import { WEEKDAYS, normalizeDay } from "./days.js";
import { errorText } from "./plan-feedback.js";
import { dropOn, movesOf } from "./week-order.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** True when every day of `days` (the week strip's entries) names a weekday, so the week can be rearranged. */
export const canMoveWeek = (days) => days.length > 1 && days.every((d) => normalizeDay(d.day));

let sheet = null;

function sheetElement() {
  if (sheet) return sheet;
  sheet = document.createElement("dialog");
  sheet.className = "sheet";
  sheet.setAttribute("aria-labelledby", "rearrangeTitle");
  document.body.appendChild(sheet);
  // A tap on the backdrop (outside the sheet's box) closes it, without saving.
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  return sheet;
}

const GRIP = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`;
const LOCK = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Fixed"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

/**
 * Opens the sheet on `program`'s week (its weeklyStructure and sessions).
 * `fixedSessions` are the athlete's or group's { day, activity } fixed
 * sessions. `onSaved(moves)` runs once the new order is saved.
 */
export function openRearrangeSheet({ programId, program, fixedSessions, isGroup, report, onSaved }) {
  const structure = new Map((program.weeklyStructure || []).map((d) => [normalizeDay(d.day), d]));
  const fixed = new Map((fixedSessions || []).map((s) => [normalizeDay(s.day), s.activity]).filter(([day]) => day));
  // What each day of the week holds now, by its weekday.
  const days = Object.fromEntries(WEEKDAYS.map((day) => {
    const exercises = (program.sessions || []).filter((s) => normalizeDay(s.day) === day)
      .reduce((n, s) => n + (s.exercises || []).length, 0);
    const focus = structure.get(day)?.focus;
    const rest = !exercises && (!focus || /^rest\b/i.test(focus));
    return [day, {
      name: fixed.get(day) ?? (rest ? "Rest" : focus || "Training"),
      sub: fixed.has(day) ? `Fixed in ${isGroup ? "your group's settings" : "your profile"}`
        : rest ? "Rest day" : `${exercises} exercise${exercises === 1 ? "" : "s"}`,
      rest,
    }];
  }));
  const locked = WEEKDAYS.map((day) => fixed.has(day));
  const start = WEEKDAYS.slice();
  let order = start.slice();
  let dragging = null; // the day being dragged, while a drag is on

  const el = sheetElement();
  el.innerHTML = `
    <div class="sheet-head">
      <h3 id="rearrangeTitle">Rearrange your week</h3>
      <button class="sheet-close" type="button" aria-label="Close without saving">✕</button>
    </div>
    <p class="muted small" style="margin:0 0 12px">Drag a session by its handle to another day. The days in between shift along.${
      isGroup ? " This changes the week for everyone in your group." : ""}</p>
    <div class="rw-list" id="rearrangeList"></div>
    <p class="muted small rw-summary" id="rearrangeSummary" role="status"></p>
    <div class="rw-actions">
      <button class="btn secondary" id="rearrangeReset" type="button">Reset</button>
      <button class="btn" id="rearrangeSave" type="button">Save new order</button>
    </div>
    <p class="status-line" id="rearrangeStatus" role="status"></p>`;

  const $ = (sel) => el.querySelector(sel);
  const list = $("#rearrangeList");

  // The rows are drawn once and then updated in place, so the handle under
  // a finger stays in the page for the whole drag (Safari stops sending a
  // touch's events once its element is removed).
  list.innerHTML = WEEKDAYS.map((weekday, i) => `<div class="rw-row" data-slot="${i}">
      <span class="rw-day">${esc(weekday.slice(0, 3))}</span>
      <div class="rw-card${locked[i] ? " locked" : ""}">
        ${locked[i]
          ? `<span class="rw-icon">${LOCK}</span>`
          : `<button class="rw-handle" type="button" data-slot="${i}">${GRIP}</button>`}
        <span class="rw-text"><b></b><span class="muted small"></span></span>
      </div>
    </div>`).join("");
  const rows = [...list.querySelectorAll(".rw-row")];

  const render = () => {
    rows.forEach((row, i) => {
      const d = days[order[i]];
      row.querySelector(".rw-card").classList.toggle("dragging", dragging === i);
      row.querySelector(".rw-handle")?.setAttribute("aria-label",
        `Move ${d.name} (${WEEKDAYS[i]}). Drag, or use the up and down arrow keys.`);
      const name = row.querySelector(".rw-text b");
      name.textContent = d.name;
      name.classList.toggle("rest", d.rest);
      row.querySelector(".rw-text span").textContent = d.sub;
    });
    const changed = order.filter((day, i) => day !== start[i]).length;
    $("#rearrangeSummary").textContent = changed
      ? `${changed} days change. Nothing is saved until you tap Save.`
      : "No changes yet.";
    $("#rearrangeReset").disabled = $("#rearrangeSave").disabled = !changed;
  };

  // Dragging: the list holds the pointer, as the session passes from row to
  // row. One finger at a time; near the sheet's top or bottom edge it scrolls.
  let pointer = null;
  const slotAt = (y) => {
    let best = null, dist = Infinity;
    rows.forEach((row, slot) => {
      if (locked[slot]) return;
      const r = row.getBoundingClientRect();
      const d = Math.abs(y - (r.top + r.height / 2));
      if (d < dist) { dist = d; best = slot; }
    });
    return best;
  };
  list.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".rw-handle");
    if (!handle || e.button > 0 || dragging !== null) return;
    e.preventDefault();
    dragging = Number(handle.dataset.slot);
    pointer = e.pointerId;
    list.setPointerCapture(e.pointerId);
    render();
  });
  list.addEventListener("pointermove", (e) => {
    if (dragging === null || e.pointerId !== pointer) return;
    const box = el.getBoundingClientRect();
    if (e.clientY < box.top + 48) el.scrollTop -= 12;
    else if (e.clientY > box.bottom - 48) el.scrollTop += 12;
    const to = slotAt(e.clientY);
    if (to === null || to === dragging) return;
    order = dropOn(order, locked, dragging, to);
    dragging = to;
    render();
  });
  const endDrag = (e) => {
    if (dragging === null || e.pointerId !== pointer) return;
    dragging = pointer = null;
    render();
  };
  list.addEventListener("pointerup", endDrag);
  list.addEventListener("pointercancel", endDrag);
  list.addEventListener("lostpointercapture", endDrag);

  // From the keyboard: the arrow keys move the focused session a day.
  list.addEventListener("keydown", (e) => {
    const handle = e.target.closest(".rw-handle");
    if (!handle || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const from = Number(handle.dataset.slot);
    const open = WEEKDAYS.map((_, i) => i).filter((i) => !locked[i]);
    const to = open[open.indexOf(from) + (e.key === "ArrowUp" ? -1 : 1)];
    if (to === undefined) return;
    order = dropOn(order, locked, from, to);
    render();
    list.querySelector(`.rw-handle[data-slot="${to}"]`)?.focus();
  });

  $(".sheet-close").addEventListener("click", () => el.close());
  $("#rearrangeReset").addEventListener("click", () => {
    order = start.slice();
    render();
  });
  $("#rearrangeSave").addEventListener("click", async () => {
    const moves = movesOf(order);
    if (!Object.keys(moves).length) return;
    const btn = $("#rearrangeSave");
    btn.disabled = $("#rearrangeReset").disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Saving…`;
    $("#rearrangeStatus").textContent = "";
    try {
      await httpsCallable(functions, "moveProgramDay")({ programId, moves });
    } catch (err) {
      btn.textContent = "Save new order";
      render();
      $("#rearrangeStatus").textContent = errorText(err);
      return;
    }
    el.close();
    report(isGroup ? "Saved your group's new week." : "Saved your new week.");
    await onSaved(moves);
  });

  render();
  el.showModal();
}
