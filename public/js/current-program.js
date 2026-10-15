// The athlete's current program, as program.html and the dashboard's Today
// card show it: their own users/{uid}/programs/{currentProgramId}, or — for
// a group member — the group's active program with their own member layer
// on top (not their personal currentProgramId, which would be a stale,
// pre-group or previous-cycle plan).
import { doc, getDoc, collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { normalizeDay } from "./days.js";
import { groupPlan } from "./plan-updates.js";

// Compares stored day names as weekdays ("Mon" and "Monday" are one day),
// falling back to the exact text for one that names no weekday ("Day 1").
export const dayKey = (day) => normalizeDay(day) ?? day;

// A rest day is sometimes written as a "Rest" session holding a "Rest"
// placeholder (or nothing) — not a session to train. Judged by its
// exercises, not its label: a "Recovery run" is still a run, and "Rest"
// must be a word of its own ("Rest day", not "Rest-pause Bench").
export const isRestSession = (session) => (session.exercises || []).every((ex) => /^rest(\s|$)/i.test(ex.name || ""));

/**
 * "~N weeks" from today to an event's ISO `date`, or null if it has none or
 * it doesn't parse. Mirrors computeWeeksOut in
 * functions/src/lib/eventReconciliation.ts, whose stored `weeksOut` is only
 * right on the day the plan was generated.
 */
export function weeksOut(date, today = new Date()) {
  if (!date) return null;
  const eventMs = new Date(date).getTime();
  if (!Number.isFinite(eventMs)) return null;
  const days = Math.round((eventMs - today.getTime()) / 86_400_000);
  return `~${Math.max(0, Math.round(days / 7))} weeks`;
}

/** Every session `program` schedules on `day` (a day can hold more than one), without rest placeholders. */
export const sessionsOn = (program, day) =>
  (program.sessions || []).filter((s) => dayKey(s.day) === dayKey(day) && !isRestSession(s));

// A group's shared session skeleton has load_note stripped; overlay this
// member's own sessionLoads (from groups/{groupId}/members/{uid}) onto it
// by day + exercise name + occurrence order (the Nth "Running" on a day gets
// the Nth "Running" load, across all of that day's sessions) — mirrors
// functions/src/lib/sessionLoads.ts.
function applySessionLoads(sessions, sessionLoads) {
  const loadsByDay = new Map();
  for (const day of sessionLoads || []) {
    const loads = loadsByDay.get(dayKey(day.day)) ?? { byName: new Map(), seen: new Map() };
    for (const ex of day.exercises || []) loads.byName.set(ex.name, [...(loads.byName.get(ex.name) || []), ex.load_note]);
    loadsByDay.set(dayKey(day.day), loads);
  }
  return (sessions || []).map((session) => {
    const loads = loadsByDay.get(dayKey(session.day));
    if (!loads) return session;
    return {
      ...session,
      exercises: (session.exercises || []).map((ex) => {
        const n = loads.seen.get(ex.name) || 0;
        loads.seen.set(ex.name, n + 1);
        const notes = loads.byName.get(ex.name);
        return notes && n < notes.length ? { ...ex, load_note: notes[n] ?? null } : ex;
      }),
    };
  });
}

/**
 * The current program for `uid` given their users/{uid}/state/summary data,
 * or null if there's none yet. `planId` identifies it for js/plan-updates.js;
 * its `updatedAt` Timestamp is when the athlete's plan last changed.
 */
export async function loadCurrentProgram(uid, summary) {
  if (summary?.activeProgramSource === "group" && summary?.groupId) {
    const activeSnap = await getDocs(query(
      collection(db, "groups", summary.groupId, "programs"),
      where("status", "==", "active"),
      limit(1)
    ));
    const sharedDoc = activeSnap.docs[0];
    if (!sharedDoc) return null;
    const shared = sharedDoc.data();
    const memberSnap = await getDoc(doc(db, "groups", summary.groupId, "members", uid));
    const member = memberSnap.exists() ? memberSnap.data() : null;
    const plan = groupPlan(sharedDoc.id, member);
    return {
      ...shared,
      sessions: applySessionLoads(shared.sessions, member?.sessionLoads),
      currentState: member?.currentState ?? null,
      coachNotes: member?.coachNotes ?? null,
      sportNotes: member?.sportNotes ?? null,
      nutritionNote: member?.nutritionNote ?? null,
      changeSummary: plan.changeSummary,
      planId: plan.planId,
      // A weekly update rewrites only the member layer, so the shared
      // program's createdAt is when the cycle began, not when it last changed.
      updatedAt: member?.updatedAt ?? shared.createdAt ?? null,
      // What this member's layer was written from (see plan-update-readiness.js).
      profileSnapshot: member?.profileSnapshot ?? shared.profileSnapshots?.[uid] ?? null,
      inputsReadAt: member?.inputsReadAt ?? null,
    };
  }
  if (summary?.currentProgramId) {
    const programSnap = await getDoc(doc(db, "users", uid, "programs", summary.currentProgramId));
    if (!programSnap.exists()) return null;
    const program = programSnap.data();
    // Every personal update writes a new program doc.
    return { ...program, planId: programSnap.id, updatedAt: program.createdAt ?? null };
  }
  return null;
}
