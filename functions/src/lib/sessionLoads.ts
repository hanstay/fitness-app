// Merges a group member's personalized load_notes (sessionLoadsSchema) onto
// the group's shared session skeleton (load_note stripped/null there) — used
// server-side to shape the onCall response the same way a personal program
// looks, and mirrored client-side (public/js) for rendering program.html.
import { SessionOutput, SessionLoadsOutput } from "./schemas";

export function applySessionLoads(sessions: SessionOutput[], sessionLoads: SessionLoadsOutput): SessionOutput[] {
  const loadsByDay = new Map<string, Map<string, string | null>>();
  for (const day of sessionLoads) {
    const byName = new Map<string, string | null>();
    for (const ex of day.exercises) byName.set(ex.name, ex.load_note);
    loadsByDay.set(day.day, byName);
  }
  return sessions.map((session) => {
    const byName = loadsByDay.get(session.day);
    if (!byName) return session;
    return {
      ...session,
      exercises: session.exercises.map((ex) => ({
        ...ex,
        load_note: byName.has(ex.name) ? byName.get(ex.name) ?? null : ex.load_note,
      })),
    };
  });
}
