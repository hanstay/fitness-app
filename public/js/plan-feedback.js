// Plan feedback in the app: the check-in's "Something not right?" notes and
// the Program page's exercise swaps. The tags, reasons and scopes mirror
// functions/src/lib/planFeedback.ts and functions/src/lib/exerciseSwap.ts
// (a plain browser module, with no build step to share them) — keep them in
// step; the labels here are the app's own.

// In order of precedence: the first one a note has decides its follow-up.
export const FEEDBACK_TAGS = [
  ["pain", "Pain or discomfort"],
  ["no_equipment", "No equipment"],
  ["too_hard", "Too hard"],
  ["too_easy", "Too easy"],
  ["dislike", "Don't like it"],
  ["question", "Question"],
];
// "checkin" marks an answer to a check-in question; it's never picked on the form.
const TAG_LABEL = { ...Object.fromEntries(FEEDBACK_TAGS), checkin: "Check-in answer" };
export const tagLabel = (tag) => TAG_LABEL[tag] ?? tag;
export const isQuestionOnly = (tags) => tags.length > 0 && tags.every((t) => t === "question");
// Note limits, not counting check-in answers: waiting for the next update,
// and in play (waiting or ongoing).
export const MAX_PENDING_NOTES = 10;
export const MAX_ACTIVE_NOTES = 20;

export const SWAP_REASONS = [
  ["hurts", "It hurts"],
  ["no_equipment", "No equipment"],
  ["dislike", "Don't like it"],
  ["too_hard", "Too hard"],
  ["too_easy", "Too easy"],
];

export const SWAP_SCOPES = [
  ["this_week", "Just this week"],
  ["rest_of_block", "Rest of this block"],
];

export const PAIN_SAFETY = "Sharp, sudden or worsening pain? Stop that exercise and see a physio or doctor. Your plan can work around discomfort, but it can't diagnose it.";

/** What a note is about, in a few words: its exercise (and day), else the start of what they wrote. */
export function noteTitle(note) {
  if (note.exercise) return note.day ? `${note.exercise} · ${note.day}` : note.exercise;
  const text = String(note.text ?? "").trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || tagLabel(note.tags?.[0]);
}

/**
 * The check-in follow-up's answers for an open note, as [outcome, label]:
 * pain asks how it feels; anything else asks whether to keep the change.
 * `worse` is offered separately, as a smaller link, on pain notes only.
 */
export function followUpChoices(note) {
  return (note.tags || []).includes("pain")
    ? [["better", "Feels better"], ["still", "Still hurts"], ["worse", "Getting worse"]]
    : [["still", "Keep the change"], ["better", "Bring it back"]];
}

/** The follow-up's question for an open note. */
export const followUpQuestion = (note) => ((note.tags || []).includes("pain")
  ? "How does it feel now?"
  : "Keep working around it, or bring it back?");

/** What the follow-up says once it's answered. */
export function followUpDone(note, outcome) {
  const pain = (note.tags || []).includes("pain");
  if (outcome === "worse") return "Got it. Your next update will ease off further. If it keeps getting worse, please see a physio or doctor.";
  if (outcome === "better") return pain ? "Good to hear. Your next update can bring it back, starting lighter." : "Your next update will bring it back.";
  return pain ? "Got it. Your next update keeps working around it." : "Your plan keeps the change.";
}

/** A callable's error as a sentence for the page (its message is already written for people). */
export const errorText = (err) => String(err?.message || err).replace(/^FirebaseError:\s*/, "");
