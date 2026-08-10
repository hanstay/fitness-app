// Repeatable "target events" editor shared by onboarding + profile.
// Each event is { name: string, date: string|null } — the same shape the
// generateProgram prompt and program.html read from athlete.events. Kept
// framework-free (plain DOM) to match the rest of the app.

function eventRow(name = "", date = "") {
  const row = document.createElement("div");
  row.className = "event-row";
  row.style.cssText = "display:flex; gap:8px; align-items:center; margin-bottom:8px";

  const nameInput = document.createElement("input");
  nameInput.className = "input event-name";
  nameInput.type = "text";
  nameInput.placeholder = "Event name (e.g. Hyrox London)";
  nameInput.maxLength = 120;
  nameInput.value = name;
  nameInput.style.flex = "1";

  const dateInput = document.createElement("input");
  dateInput.className = "input event-date";
  dateInput.type = "date";
  dateInput.value = date || "";
  dateInput.style.cssText = "flex:0 0 auto; width:auto";

  const removeBtn = document.createElement("button");
  removeBtn.className = "btn secondary event-remove";
  removeBtn.type = "button";
  removeBtn.setAttribute("aria-label", "Remove event");
  removeBtn.textContent = "✕";
  removeBtn.style.flex = "0 0 auto";
  removeBtn.addEventListener("click", () => row.remove());

  row.append(nameInput, dateInput, removeBtn);
  return row;
}

/**
 * Renders the repeatable editor into `container`, seeded with `initialEvents`
 * (array of { name, date }). Starts with one blank row when there are none.
 */
export function renderEventsEditor(container, initialEvents = []) {
  container.innerHTML = "";

  const list = document.createElement("div");
  list.className = "event-list";
  container.appendChild(list);

  const addBtn = document.createElement("button");
  addBtn.className = "btn secondary event-add";
  addBtn.type = "button";
  addBtn.textContent = "+ Add another event";
  addBtn.addEventListener("click", () => list.appendChild(eventRow()));
  container.appendChild(addBtn);

  const events = initialEvents || [];
  if (events.length === 0) {
    list.appendChild(eventRow());
  } else {
    events.forEach((e) => list.appendChild(eventRow(e.name || "", e.date || "")));
  }
}

/** Reads the rows back out as [{ name, date }], dropping any row with no name. */
export function collectEvents(container) {
  const out = [];
  container.querySelectorAll(".event-row").forEach((row) => {
    const name = row.querySelector(".event-name").value.trim().slice(0, 120);
    const date = row.querySelector(".event-date").value || null; // YYYY-MM-DD
    if (name) out.push({ name, date });
  });
  return out;
}
