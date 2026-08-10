// Repeatable "fixed weekly sessions" editor shared by onboarding + profile.
// Captures already-committed sessions that are part of the athlete's training
// days — typically group classes (e.g. Wed → Hyrox class). Each item is
// { day: string, activity: string }; the generateProgram prompt anchors these
// on their weekday and programs the rest of the week around them.

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function commitmentRow(day = "", activity = "") {
  const row = document.createElement("div");
  row.className = "commitment-row";
  row.style.cssText = "display:flex; gap:8px; align-items:center; margin-bottom:8px";

  const daySelect = document.createElement("select");
  daySelect.className = "input commitment-day";
  daySelect.style.cssText = "flex:0 0 auto; width:auto";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Day…";
  daySelect.appendChild(blank);
  DAYS.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    daySelect.appendChild(opt);
  });
  daySelect.value = day;

  const activityInput = document.createElement("input");
  activityInput.className = "input commitment-activity";
  activityInput.type = "text";
  activityInput.placeholder = "What it is (e.g. Hyrox class, CrossFit)";
  activityInput.maxLength = 120;
  activityInput.value = activity;
  activityInput.style.flex = "1";

  const removeBtn = document.createElement("button");
  removeBtn.className = "btn secondary commitment-remove";
  removeBtn.type = "button";
  removeBtn.setAttribute("aria-label", "Remove session");
  removeBtn.textContent = "✕";
  removeBtn.style.flex = "0 0 auto";
  removeBtn.addEventListener("click", () => row.remove());

  row.append(daySelect, activityInput, removeBtn);
  return row;
}

/**
 * Renders the editor into `container`, seeded with `initial` (array of
 * { day, activity }). Starts with one blank row when there are none.
 */
export function renderCommitmentsEditor(container, initial = []) {
  container.innerHTML = "";

  const list = document.createElement("div");
  list.className = "commitment-list";
  container.appendChild(list);

  const addBtn = document.createElement("button");
  addBtn.className = "btn secondary commitment-add";
  addBtn.type = "button";
  addBtn.textContent = "+ Add another class";
  addBtn.addEventListener("click", () => list.appendChild(commitmentRow()));
  container.appendChild(addBtn);

  const items = initial || [];
  if (items.length === 0) {
    list.appendChild(commitmentRow());
  } else {
    items.forEach((c) => list.appendChild(commitmentRow(c.day || "", c.activity || "")));
  }
}

/** Reads the rows back as [{ day, activity }], dropping rows missing either field. */
export function collectCommitments(container) {
  const out = [];
  container.querySelectorAll(".commitment-row").forEach((row) => {
    const day = row.querySelector(".commitment-day").value;
    const activity = row.querySelector(".commitment-activity").value.trim().slice(0, 120);
    if (day && activity) out.push({ day, activity });
  });
  return out;
}
