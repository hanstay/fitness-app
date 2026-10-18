// The Trainer's advice page's "Check-in history": every plan update's What
// changed, newest first, after the Program page's box has been closed. Each
// update since the history started writes users/{uid}/planHistory
// (functions/src/lib/planHistory.ts); before that, a personal plan's
// archived programs carry the same fields, so they fill in the older ones.
import { collection, query, orderBy, limit, startAfter, getDocs } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { db } from "./firebase-init.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// What the athlete's note or check-in answer was about, as a short title.
const feedbackTitle = (r) => r.exercise ? `${r.exercise}${r.day ? ` · ${r.day}` : ""}`
  : r.answer ? (r.day || "Your week")
  : (r.text ?? "").length > 50 ? `${r.text.slice(0, 47)}…` : r.text ?? "";

/** An update's answer to each note and check-in answer it was given: what they said, then what changed. */
export function feedbackResponsesHtml(responses) {
  if (!(responses || []).length) return "";
  return `<h3 class="fb-said-head">From your check-in</h3>
    ${responses.map((r) => `<div class="fb-said">
      <div class="you">${esc(feedbackTitle(r))}${r.answer ? ` · you said <b>${esc(r.answer)}</b>` : ""}</div>
      <div class="did">${esc(r.response)}</div>
    </div>`).join("")}`;
}

const MODE_LABEL = { incremental: "Weekly update", advance: "New phase", full: "New plan", rebuild: "Week rebuilt" };
const PAGE = 10;

function fromHistory(d) {
  const h = d.data();
  return {
    programId: h.programId ?? null, at: h.createdAt?.toDate?.() ?? null, mode: h.mode ?? null, phase: h.phase ?? null,
    summary: h.summary ?? null, changeSummary: h.changeSummary ?? [], feedbackResponses: h.feedbackResponses ?? [],
  };
}

function fromProgram(d) {
  const p = d.data();
  const phaseIndex = Number.isInteger(p.currentPhaseIndex) ? p.currentPhaseIndex : 0;
  return {
    programId: d.id, at: p.createdAt?.toDate?.() ?? null, mode: null, phase: p.roadmap?.[phaseIndex]?.phase ?? null,
    summary: p.currentState?.summary ?? null, changeSummary: p.changeSummary ?? [], feedbackResponses: p.feedbackResponses ?? [],
  };
}

/**
 * The history, a page at a time: next() gives the next entries, newest
 * first, and whether there are more. The two sources are merged by date;
 * an archived program that has its own history entry is shown once.
 */
export function planHistory(uid) {
  const sources = [
    { ref: collection(db, "users", uid, "planHistory"), map: fromHistory, buffer: [], last: null, done: false },
    { ref: collection(db, "users", uid, "programs"), map: fromProgram, buffer: [], last: null, done: false },
  ];
  const [history] = sources;
  const shown = new Set(); // programs with a history entry already given

  async function top(source) {
    if (!source.buffer.length && !source.done) {
      const q = query(source.ref, orderBy("createdAt", "desc"), ...(source.last ? [startAfter(source.last)] : []), limit(PAGE));
      const snap = await getDocs(q);
      source.buffer = snap.docs.map(source.map);
      source.last = snap.docs.at(-1) ?? source.last;
      source.done = snap.docs.length < PAGE;
    }
    return source.buffer[0] ?? null;
  }

  async function nextOne() {
    for (;;) {
      const [h, p] = await Promise.all(sources.map(top));
      if (!h && !p) return null;
      // A history entry is written with its program, so on a tie it goes first.
      const source = !p || (h && (h.at ?? 0) >= (p.at ?? 0)) ? history : sources[1];
      const entry = source.buffer.shift();
      if (source === history) { if (entry.programId) shown.add(entry.programId); return entry; }
      if (!shown.has(entry.programId)) return entry;
    }
  }

  return {
    async next(count = PAGE) {
      const entries = [];
      for (let i = 0; i < count; i++) {
        const entry = await nextOne();
        if (!entry) break;
        entries.push(entry);
      }
      const more = (await Promise.all(sources.map(top))).some(Boolean);
      // The oldest plan, from before change summaries, was the first one made.
      const last = entries.at(-1);
      if (!more && last && !last.mode && !last.changeSummary.length) last.created = true;
      return { entries, more };
    },
  };
}

/** One update as an accordion item (the advice page's .phase), open if `open`. */
export function historyEntryHtml(entry, { open = false } = {}) {
  const date = entry.at ? entry.at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  const label = entry.created ? "Plan created" : MODE_LABEL[entry.mode] ?? "Plan updated";
  const changes = entry.changeSummary.length ? `<ul class="small">${entry.changeSummary.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : "";
  const read = entry.summary ? `<h3 class="fb-said-head">Where you were</h3><p class="small">${esc(entry.summary)}</p>` : "";
  const body = changes + feedbackResponsesHtml(entry.feedbackResponses) + read || `<p class="muted small">No details were saved for this update.</p>`;
  return `<div class="phase${open ? " open" : ""}">
    <h3 class="ph-head"><span class="ph-title">${esc(label)}</span>${entry.phase ? `<span class="phase-badge">${esc(entry.phase)}</span>` : ""}<span class="muted small ph-dates">${esc(date)}</span><span class="caret">▾</span></h3>
    <div class="ph-body">${body}</div>
  </div>`;
}
