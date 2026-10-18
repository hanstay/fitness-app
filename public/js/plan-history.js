// The Trainer's advice page's "Check-in history": every plan update's What
// changed, newest first, after the Program page's box has been closed. Each
// update since the history started writes users/{uid}/planHistory
// (functions/src/lib/planHistory.ts); before that, a personal plan's
// archived programs carry the same fields, so they fill in the older ones.
import { collection, query, where, orderBy, limit, startAfter, getDocs } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
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
  if (p.status === "generating") return null; // an update still being written
  const phaseIndex = Number.isInteger(p.currentPhaseIndex) ? p.currentPhaseIndex : 0;
  return {
    programId: d.id, at: p.createdAt?.toDate?.() ?? null, mode: null, phase: p.roadmap?.[phaseIndex]?.phase ?? null,
    summary: p.currentState?.summary ?? null, changeSummary: p.changeSummary ?? [], feedbackResponses: p.feedbackResponses ?? [],
  };
}

/**
 * The history, a page at a time: next() gives the next entries, newest
 * first, and whether there are more. The history entries come first; then
 * the programs from before the oldest of them (every later program has its
 * own entry), so no program is read only to be skipped.
 */
export function planHistory(uid) {
  const historyRef = collection(db, "users", uid, "planHistory");
  const programsRef = collection(db, "users", uid, "programs");
  let programsBefore; // the oldest entry's time, once looked up (null: no entries)
  const sources = [
    { base: () => query(historyRef, orderBy("createdAt", "desc")), map: fromHistory },
    {
      base: async () => {
        if (programsBefore === undefined) {
          const oldest = await getDocs(query(historyRef, orderBy("createdAt"), limit(1)));
          programsBefore = oldest.docs[0]?.get("createdAt") ?? null;
        }
        return programsBefore
          ? query(programsRef, where("createdAt", "<", programsBefore), orderBy("createdAt", "desc"))
          : query(programsRef, orderBy("createdAt", "desc"));
      },
      map: fromProgram,
    },
  ].map((s) => ({ ...s, buffer: [], last: null, done: false }));

  // The source's next entry, fetching a page when its buffer runs out.
  async function top(source) {
    while (!source.buffer.length && !source.done) {
      const q = query(await source.base(), ...(source.last ? [startAfter(source.last)] : []), limit(PAGE));
      const snap = await getDocs(q);
      source.buffer = snap.docs.map(source.map).filter(Boolean);
      source.last = snap.docs.at(-1) ?? source.last;
      source.done = snap.docs.length < PAGE;
    }
    return source.buffer[0] ?? null;
  }

  async function peek() {
    for (const source of sources) if (await top(source)) return source;
    return null;
  }

  return {
    async next(count = PAGE) {
      const entries = [];
      for (let source; entries.length < count && (source = await peek());) entries.push(source.buffer.shift());
      const more = (await peek()) != null;
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
