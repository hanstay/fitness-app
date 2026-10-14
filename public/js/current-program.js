// The athlete's current program, as program.html and the dashboard's Today
// card show it: their own users/{uid}/programs/{currentProgramId}, or — for
// a group member — the group's active program with their own member layer
// on top (not their personal currentProgramId, which would be a stale,
// pre-group or previous-cycle plan).
import { doc, getDoc, collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { normalizeDay } from "./days.js";

// A group's shared session skeleton has load_note stripped; overlay this
// member's own sessionLoads (from groups/{groupId}/members/{uid}) onto it
// by day + exercise name + occurrence order (the Nth "Running" in a session
// gets the Nth "Running" load) — mirrors functions/src/lib/sessionLoads.ts.
function applySessionLoads(sessions, sessionLoads) {
  const loadsByDay = new Map();
  for (const day of sessionLoads || []) {
    const byName = new Map();
    for (const ex of day.exercises || []) byName.set(ex.name, [...(byName.get(ex.name) || []), ex.load_note]);
    loadsByDay.set(normalizeDay(day.day) ?? day.day, byName);
  }
  return (sessions || []).map((session) => {
    const byName = loadsByDay.get(normalizeDay(session.day) ?? session.day);
    if (!byName) return session;
    const seen = new Map();
    return {
      ...session,
      exercises: (session.exercises || []).map((ex) => {
        const n = seen.get(ex.name) || 0;
        seen.set(ex.name, n + 1);
        const loads = byName.get(ex.name);
        return loads && n < loads.length ? { ...ex, load_note: loads[n] ?? null } : ex;
      }),
    };
  });
}

/** The current program for `uid` given their users/{uid}/state/summary data, or null if there's none yet. */
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
    return {
      ...shared,
      sessions: applySessionLoads(shared.sessions, member?.sessionLoads),
      currentState: member?.currentState ?? null,
      coachNotes: member?.coachNotes ?? null,
      sportNotes: member?.sportNotes ?? null,
      nutritionNote: member?.nutritionNote ?? null,
    };
  }
  if (summary?.currentProgramId) {
    const programSnap = await getDoc(doc(db, "users", uid, "programs", summary.currentProgramId));
    return programSnap.data() ?? null;
  }
  return null;
}
